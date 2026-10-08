import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { call } from '../../lib/hps-cli.mjs';
import { HpsRuntime } from '../../lib/hps-runtime.mjs';
import { createVerificationRunner } from '../../lib/hps-verification.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'tests/hps/fixtures/verification-runner-fixture.mjs');

test('unknown capabilities stay false and process/network gates fail closed', async () => {
  const runtime = new HpsRuntime({ capabilities: { workspace_read: true, local_process: false } });
  const doctor = await runtime.runtimeDoctor();
  assert.equal(doctor.capabilities.workspace_read, true);
  for (const capability of ['workspace_write', 'external_network', 'wiki_read', 'wiki_submit', 'persistent_session', 'approval_available']) {
    assert.equal(doctor.capabilities[capability], false, capability);
  }
  const scope_id = runtime.openScope({ root: repoRoot });
  const noProcess = await runtime.verificationRun({ cwd: repoRoot, scope_id, profile: 'hps-unit' });
  assert.equal(noProcess.error_code, 'local_process_required');

  const run = createVerificationRunner({ profiles: {
    network: { id: 'network', program: process.execPath, args: [fixture, 'pass'], timeout_ms: 1_000, network: true }
  } });
  const noNetwork = await run({ profile: 'network', cwd: repoRoot, capabilities: { local_process: true, external_network: false } });
  assert.equal(noNetwork.error_code, 'network_required');
});

test('missing host capability facts fail closed for local process', async () => {
  const runtime = new HpsRuntime();
  const doctor = await runtime.runtimeDoctor();
  assert.equal(doctor.capabilities.local_process, false);
  const scope_id = runtime.openScope({ root: repoRoot });
  const result = await runtime.verificationRun({ cwd: repoRoot, scope_id, profile: 'hps-unit' });
  assert.equal(result.error_code, 'local_process_required');
});

test('company Wiki unavailable never falls back to qmd or local Wiki grep', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({
    root: repoRoot,
    document_context: { status: 'wiki_unavailable', identity_status: 'company', documentation: { backend: 'disabled' } }
  });
  const result = await runtime.contextCollect({ cwd: repoRoot, scope_id, query: 'HpsRuntime' });
  assert.equal(result.branches.wiki.status, 'skipped');
  assert.equal(result.branches.wiki.error_code, 'DOCUMENT_RUNTIME_REQUIRED');
  assert.notEqual(result.branches.wiki.tool, 'qmd search');
  assert.notEqual(result.branches.wiki.tool, 'grep -RIn');
});

test('request schema rejects shell, argv, env, host, path, URI, and collection carriers before runtime dispatch', async () => {
  let calls = 0;
  const runtime = new Proxy({}, { get: () => async () => { calls += 1; return { status: 'ok' }; } });
  const cases = [
    ['verification_run', { scope_id: 'scope-a', profile: 'hps-unit', command: 'node' }],
    ['verification_run', { scope_id: 'scope-a', profile: 'hps-unit', argv: ['--test'] }],
    ['verification_run', { scope_id: 'scope-a', profile: 'hps-unit', env: { TOKEN: 'x' } }],
    ['verification_run', { scope_id: 'scope-a', profile: 'hps-unit', host: 'example.invalid' }],
    ['document_get', { scope_id: 'scope-a', path: '/tmp/a' }],
    ['document_get', { scope_id: 'scope-a', uri: 'qmd://other/a' }],
    ['document_search', { scope_id: 'scope-a', query: 'x', collection: 'other' }]
  ];
  for (const [operation, input] of cases) {
    const response = await call(JSON.stringify({
      schema_version: 1, request_id: `reject-${operation}-${calls}`, operation, cwd: repoRoot, input
    }), runtime);
    assert.equal(response.error.code, 'invalid_request', JSON.stringify(input));
  }
  assert.equal(calls, 0);
});

test('read-only Git and document probes show no mutation path', async () => {
  const gitCalls = [];
  const runtime = new HpsRuntime({
    capabilities: { workspace_read: true, workspace_write: false },
    gitExec: async (file, args, options) => {
      gitCalls.push({ file, args, options });
      const command = args.join(' ');
      if (command.includes('rev-parse --show-toplevel')) return { stdout: `${repoRoot}\n` };
      if (command.includes('branch --show-current')) return { stdout: 'codex/hps-agent-cli\n' };
      if (command.includes('status --porcelain')) return { stdout: '## codex/hps-agent-cli\n' };
      if (command.includes('worktree list')) return { stdout: `worktree ${repoRoot}\n` };
      return { stdout: '' };
    },
    documentExecute: async () => ({ status: 'wiki_unavailable', backend: 'wiki' })
  });
  const scope_id = runtime.openScope({ root: repoRoot });
  const git = await runtime.gitPreflight({ cwd: repoRoot });
  const document = await runtime.documentRead({ cwd: repoRoot, scope_id, action: 'search', request: { query: 'x' } });
  assert.equal(git.status, 'ready');
  assert.equal(document.status, 'wiki_unavailable');
  assert.ok(gitCalls.every((entry) => entry.file === 'git' && entry.options.shell === false));
  assert.ok(gitCalls.every((entry) => !entry.args.some((arg) => /(?:commit|merge|push|reset|clean|checkout)/u.test(arg))));
});
