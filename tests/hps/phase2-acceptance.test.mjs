import test from 'node:test';
import assert from 'node:assert/strict';

import { HpsRuntime } from '../../lib/hps-runtime.mjs';
import { HpsMcpServer } from '../../lib/hps-mcp-server.mjs';

function rules() {
  return {
    routing_rule_version: 1,
    thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
    direct: { deny_patterns: [], allow_rules: [] },
    routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
    skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
  };
}

test('git_preflight uses fixed shell-free git operations and returns parsed state', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    gitExec: async (file, args, options) => {
      calls.push({ file, args, options });
      const key = args.join(' ');
      if (key.includes('rev-parse --show-toplevel')) return { stdout: '/repo\n' };
      if (key.includes('branch --show-current')) return { stdout: 'feature/x\n' };
      if (key.includes('rev-parse --abbrev-ref')) return { stdout: 'origin/feature/x\n' };
      if (key.includes('status --porcelain=v1 --branch')) return { stdout: '## feature/x...origin/feature/x [ahead 2, behind 1]\n M src/app.mjs\n?? .env.local\n' };
      if (key.includes('rev-list')) return { stdout: '2\t1\n' };
      if (key.includes('ls-files -u')) return { stdout: '' };
      if (key.includes('worktree list')) return { stdout: 'worktree /repo\nHEAD abc\nbranch refs/heads/feature/x\n\n' };
      throw new Error(`unexpected git operation: ${key}`);
    }
  });
  const result = await runtime.gitPreflight({ cwd: '/repo' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.branch, { current: 'feature/x', upstream: 'origin/feature/x' });
  assert.deepEqual(result.sync, { ahead: 2, behind: 1 });
  assert.equal(result.dirty, true);
  assert.equal(result.conflict, false);
  assert.equal(result.sensitive_paths_excluded, 1);
  assert.ok(calls.every((call) => call.file === 'git' && call.options.shell === false));
  assert.ok(calls.every((call) => !call.args.some((arg) => arg.includes('rm') || arg.includes('|'))));
});

test('diff_snapshot returns bounded structured staged and unstaged changes', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    gitExec: async (file, args, options) => {
      calls.push({ file, args, options });
      const key = args.join(' ');
      if (key.includes('diff --stat')) return { stdout: ' src/app.mjs | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n' };
      if (key.includes('diff --name-only')) return { stdout: 'src/app.mjs\n.env\n' };
      if (key.includes('diff --cached --stat')) return { stdout: ' README.md | 1 +\n' };
      if (key.includes('diff --cached --name-only')) return { stdout: 'README.md\n' };
      throw new Error(`unexpected git operation: ${key}`);
    }
  });
  const result = await runtime.diffSnapshot({ cwd: '/repo' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.unstaged.files, ['src/app.mjs']);
  assert.deepEqual(result.staged.files, ['README.md']);
  assert.equal(result.sensitive_paths_excluded, 1);
  assert.ok(calls.every((call) => call.options.shell === false));
});

test('diff_snapshot excludes nested sensitive paths from names and stat output', async () => {
  const runtime = new HpsRuntime({
    gitExec: async (file, args, options) => {
      const key = args.join(' ');
      if (key.includes('diff --stat')) {
        return { stdout: ' src/.env.local | 1 +\n config/credentials/prod.json | 2 ++\n src/app.mjs | 1 +\n 3 files changed, 4 insertions(+)\n' };
      }
      if (key.includes('diff --name-only')) return { stdout: 'src/.env.local\nconfig/credentials/prod.json\nsrc/app.mjs\n' };
      if (key.includes('diff --cached --stat')) return { stdout: ' secrets/api-token.txt | 1 +\n README.md | 1 +\n' };
      if (key.includes('diff --cached --name-only')) return { stdout: 'secrets/api-token.txt\nREADME.md\n' };
      throw new Error(`unexpected git operation: ${key}`);
    }
  });
  const result = await runtime.diffSnapshot({ cwd: '/repo' });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.unstaged.files, ['src/app.mjs']);
  assert.deepEqual(result.staged.files, ['README.md']);
  assert.doesNotMatch(result.unstaged.stat, /\.env|credential|token/iu);
  assert.doesNotMatch(result.staged.stat, /\.env|credential|token/iu);
  assert.match(result.unstaged.stat, /src\/app\.mjs/iu);
  assert.match(result.staged.stat, /README\.md/iu);
  assert.equal(result.sensitive_paths_excluded, 3);
});

test('task_prepare creates an opaque scope and rejects it after invalidation', async () => {
  const runtime = new HpsRuntime({
    loadRules: async () => rules(),
    planProject: async () => ({ eligibility: 'external_project', project_root: '/repo', identity: { kind: 'company' } }),
    resolveProjectContext: async () => ({ status: 'ready', project: { project_id: 'p1', project_fingerprint: 'fp1', root: '/repo' }, documentation: { backend: 'wiki' } }),
    collectContext: async () => ({ branches: {} })
  });
  const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' } });
  assert.match(prepared.scope.scope_id, /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(prepared.scope.root, '/repo');
  runtime.invalidateScope(prepared.scope.scope_id);
  await assert.rejects(
    () => runtime.documentRead({ cwd: '/repo', action: 'get', scope_id: prepared.scope.scope_id, request: { logical_id: 'x' } }),
    /scope_expired/
  );
});

test('document reads reject a scope when the verified revision changes', async () => {
  let revision = 7;
  const runtime = new HpsRuntime({
    scopeFacts: async () => ({ root: '/repo', revision }),
    documentExecute: async () => ({ status: 'ok', document: { logical_id: 'x' } })
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 7 });
  await runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { logical_id: 'x' } });
  revision = 8;
  await assert.rejects(
    () => runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { logical_id: 'x' } }),
    /scope_expired/
  );
});

test('session_record is idempotent, bounded, and stores references only', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const input = { cwd: '/repo', scope_id, request_id: 'r1', idempotency_key: 'idem-1', references: [{ logical_id: 'plan-a', status: 'completed' }] };
  const first = await runtime.sessionRecord(input);
  const second = await runtime.sessionRecord(input);
  assert.deepEqual(second, first);
  assert.equal(first.status, 'ok');
  await assert.rejects(() => runtime.sessionRecord({ ...input, references: [{ logical_id: 'plan-a', content: 'secret body' }] }), /reference|content|unsafe/i);
});

test('MCP exposes only implemented phase-2 tools and returns the canonical HPS envelope', async () => {
  const server = new HpsMcpServer({ runtime: new HpsRuntime({ runtimeDoctor: async () => ({ ok: true }) }) });
  const initialized = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), [
    'checkpoint_get', 'checkpoint_put', 'commit_preview', 'context_collect', 'diff_snapshot',
    'document_get', 'document_manifest', 'document_resolve', 'document_search', 'document_verify',
    'git_preflight', 'merge_preview', 'project_context', 'project_snapshot', 'runtime_doctor',
    'session_prepare', 'session_record', 'task_prepare', 'verification_run'
  ]);
  for (const tool of listed.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.input.additionalProperties, false);
    for (const schema of Object.values(tool.inputSchema.properties.input.properties)) {
      assert.ok(schema.type || schema.anyOf || schema.enum, `${tool.name} has an untyped input property`);
    }
  }
  for (const name of ['document_get', 'document_verify']) {
    const tool = listed.result.tools.find((entry) => entry.name === name);
    assert.equal(tool.inputSchema.properties.input.oneOf.length, 2);
  }
  const called = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'runtime_doctor', arguments: { cwd: '/repo', input: {} } } });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.status, 'ok');
  assert.equal(called.result.structuredContent.schema_version, 1);
});

test('document identity operations require exactly one logical id or opaque reference', async () => {
  const { call } = await import('../../lib/hps-cli.mjs');
  for (const operation of ['document_get', 'document_verify']) {
    for (const input of [
      { scope_id: 'scope-a' },
      { scope_id: 'scope-a', logical_id: 'plan-a', document_ref: 'opaque-ref' }
    ]) {
      const response = await call(JSON.stringify({
        schema_version: 1, request_id: `${operation}-${Object.keys(input).length}`, operation, cwd: '/repo', input
      }), {});
      assert.equal(response.error.code, 'invalid_request');
    }
  }
});

test('MCP forwards project snapshot scope_id with the same contract as CLI', async () => {
  const seen = [];
  const runtime = {
    projectSnapshot: async (input) => {
      seen.push(input);
      return { root: input.cwd, remote: { status: 'unknown', remote_name: null, host: null, path: null, upstream: null } };
    }
  };
  const server = new HpsMcpServer({ runtime });
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const response = await server.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'project_snapshot', arguments: { cwd: '/repo', input: { scope_id: 'scope-a' } } }
  });
  assert.equal(response.result.isError, false);
  assert.equal(seen[0].scope_id, 'scope-a');
});

test('deferred write operations return operation_unavailable from CLI', async () => {
  const { call } = await import('../../lib/hps-cli.mjs');
  const response = await call(JSON.stringify({
    schema_version: 1, request_id: 'deferred-1', operation: 'project_bootstrap_submit', cwd: '/repo', input: {}
  }));
  assert.equal(response.status, 'error');
  assert.equal(response.error.code, 'operation_unavailable');
});

test('unscoped project snapshot closes transient qmd state after collecting verified facts', async () => {
  let closed = 0;
  const runtime = new HpsRuntime({
    planProject: async () => ({ project_root: '/repo', eligibility: 'external_project', identity: { kind: 'company' } }),
    gitPreflight: async () => ({ status: 'ready', root: '/repo', dirty: false }),
    resolveProjectContext: async () => ({
      status: 'ready', identity_status: 'company', project: { root: '/repo' },
      documentation: { backend: 'wiki' }, wiki: { qmd_client: { close: async () => { closed += 1; } } }
    })
  });
  const snapshot = await runtime.projectSnapshot({ cwd: '/repo' });
  assert.equal(snapshot.documentation.backend, 'wiki');
  assert.equal(closed, 1);
});

test('unscoped project snapshot preserves facts when transient qmd cleanup fails', async () => {
  const runtime = new HpsRuntime({
    planProject: async () => ({ project_root: '/repo', eligibility: 'external_project', identity: { kind: 'company' } }),
    gitPreflight: async () => ({ status: 'ready', root: '/repo', dirty: false }),
    resolveProjectContext: async () => ({
      status: 'ready', identity_status: 'company', project: { root: '/repo' },
      documentation: { backend: 'wiki' }, wiki: { qmd_client: { close: async () => { throw new Error('cleanup failed'); } } }
    })
  });
  const snapshot = await runtime.projectSnapshot({ cwd: '/repo' });
  assert.equal(snapshot.documentation.backend, 'wiki');
  assert.equal(snapshot.status, undefined);
});
