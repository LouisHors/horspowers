import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { call } from '../../lib/hps-cli.mjs';
import { HpsRuntime } from '../../lib/hps-runtime.mjs';

function gitFixture(status = '') {
  return async (_file, args) => {
    const key = args.join(' ');
    if (key.includes('rev-parse --show-toplevel')) return { stdout: '/repo\n' };
    if (key.includes('branch --show-current')) return { stdout: 'feature/x\n' };
    if (key.includes('rev-parse --abbrev-ref')) return { stdout: 'origin/feature/x\n' };
    if (key.includes('status --porcelain=v1 --branch')) return { stdout: `## feature/x\n${status}` };
    if (key.includes('rev-list')) return { stdout: '1\t2\n' };
    if (key.includes('ls-files -u')) return { stdout: '' };
    if (key.includes('worktree list')) return { stdout: 'worktree /repo\nHEAD abc123\n' };
    throw new Error(`unexpected git call: ${key}`);
  };
}

test('sensitive-only changes remain dirty while their names stay excluded', async () => {
  const runtime = new HpsRuntime({ gitExec: gitFixture('?? .env.local\n') });
  const result = await runtime.gitPreflight({ cwd: '/repo' });
  assert.equal(result.dirty, true);
  assert.deepEqual(result.files, []);
  assert.equal(result.sensitive_paths_excluded, 1);
});

test('default project snapshot combines project, Git, and document revision facts once', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    planProject: async () => {
      calls.push('plan');
      return { project_root: '/repo', eligibility: 'external_project', identity: { kind: 'company', project_fingerprint: 'fp' } };
    },
    gitPreflight: async () => {
      calls.push('git');
      return { status: 'ready', root: '/repo', branch: { current: 'feature/x', upstream: 'origin/feature/x' }, dirty: false, sync: { ahead: 1, behind: 2 }, conflict: false };
    },
    resolveProjectContext: async () => {
      calls.push('context');
      return { status: 'ready', config_revision: 3, manifest_revision: 7, documentation: { backend: 'wiki' } };
    }
  });

  const [first, second] = await Promise.all([
    runtime.projectSnapshot({ cwd: '/repo' }),
    runtime.projectSnapshot({ cwd: '/repo' })
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(calls.sort(), ['context', 'git', 'plan']);
  assert.equal(first.git.branch.current, 'feature/x');
  assert.equal(first.config_revision, 3);
  assert.equal(first.manifest_revision, 7);
  assert.ok(first.metrics.duration_ms >= 0);
});

test('scope validation automatically expires when bound facts change', async () => {
  let revision = 1;
  const runtime = new HpsRuntime({
    scopeFacts: async () => ({ root: '/repo', revision }),
    documentExecute: async () => ({ status: 'ok', document: { logical_id: 'plan-a' } })
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  await runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { logical_id: 'plan-a' } });
  revision = 2;
  await assert.rejects(
    () => runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { logical_id: 'plan-a' } }),
    /scope_expired/
  );
});

test('CLI forwards document scope outside the runtime request body', async () => {
  const seen = [];
  const runtime = { documentRead: async (input) => { seen.push(input); return { status: 'ok' }; } };
  const response = await call(JSON.stringify({
    schema_version: 1,
    request_id: 'scope-forward',
    operation: 'document_get',
    cwd: '/repo',
    input: { scope_id: 'scope-a', logical_id: 'plan-a' }
  }), runtime);
  assert.equal(response.status, 'ok');
  assert.equal(seen[0].scope_id, 'scope-a');
  assert.deepEqual(seen[0].request, { logical_id: 'plan-a' });
});

test('local search results can be read through an opaque document_ref without accepting a path', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    documentExecute: async (input) => {
      calls.push(input);
      if (input.action === 'search') return { status: 'ok', backend: 'local', documents: [{ path: '/repo/docs/plans/a.md', relative_path: 'plans/a.md' }] };
      return { status: 'ok', backend: 'local', document: { path: input.request.path, content: '# A' } };
    }
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const searched = await runtime.documentRead({ cwd: '/repo', action: 'search', scope_id, request: { query: 'A' } });
  assert.match(searched.documents[0].document_ref, /^[A-Za-z0-9_-]{20,}$/u);
  assert.equal(Object.hasOwn(searched.documents[0], 'path'), false);
  const fetched = await runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { document_ref: searched.documents[0].document_ref } });
  assert.equal(fetched.document.content, '# A');
  assert.deepEqual(calls[1].request, { path: '/repo/docs/plans/a.md' });
});

test('document_manifest and document_verify expose verified metadata without body content', async () => {
  const runtime = new HpsRuntime({
    documentExecute: async () => ({
      status: 'ok',
      backend: 'wiki',
      document: { logical_id: 'plan-a', revision: 4, content_sha256: 'a'.repeat(64), content: '# body' }
    })
  });
  const scope_id = runtime.openScope({ root: '/repo', project_fingerprint: 'fp', config_revision: 3, manifest_revision: 4, manifest_hash: 'b'.repeat(64) });
  const manifest = await runtime.documentManifest({ cwd: '/repo', scope_id });
  assert.equal(manifest.manifest_revision, 4);
  const verified = await runtime.documentVerify({ cwd: '/repo', scope_id, logical_id: 'plan-a' });
  assert.equal(verified.verified, true);
  assert.equal(Object.hasOwn(verified.document, 'content'), false);
  assert.equal(verified.document.revision, 4);
});

test('task_prepare scope validates current project facts and closes stale qmd state', async () => {
  let manifestRevision = 4;
  let closed = 0;
  const qmdClient = { close: async () => { closed += 1; } };
  const runtime = new HpsRuntime({
    loadRules: async () => ({
      routing_rule_version: 1,
      thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
      direct: { deny_patterns: [], allow_rules: [] },
      routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
      skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
    }),
    planProject: async () => ({
      eligibility: 'external_project', project_root: '/repo',
      identity: { kind: 'company', project_fingerprint: 'fp' }
    }),
    resolveProjectContext: async () => ({
      status: 'ready', project: { root: '/repo', project_fingerprint: 'fp' },
      config_revision: 2, manifest_revision: manifestRevision,
      documentation: { backend: 'wiki' }, wiki: { qmd_client: qmdClient }
    }),
    collectContext: async () => ({ branches: {} })
  });

  const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design' } });
  await runtime.documentManifest({ cwd: '/repo', scope_id: prepared.scope.scope_id });
  manifestRevision = 5;
  await assert.rejects(
    () => runtime.documentManifest({ cwd: '/repo', scope_id: prepared.scope.scope_id }),
    /scope_expired/u
  );
  assert.equal(closed, 1);
});

test('scope digest excludes circular runtime and qmd objects', async () => {
  const qmdClient = {};
  qmdClient.self = qmdClient;
  const runtime = new HpsRuntime({
    loadRules: async () => ({
      routing_rule_version: 1,
      thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
      direct: { deny_patterns: [], allow_rules: [] },
      routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
      skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
    }),
    planProject: async () => ({ eligibility: 'external_project', project_root: '/repo', identity: { kind: 'company' } }),
    resolveProjectContext: async () => ({
      status: 'ready', project: { root: '/repo' }, documentation: { backend: 'wiki' }, wiki: { qmd_client: qmdClient }
    }),
    collectContext: async () => ({ branches: {} })
  });

  const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design' } });
  assert.match(prepared.scope.scope_id, /^[A-Za-z0-9_-]{20,}$/u);
});

test('scope invalidation clears every scope-bound state store', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo' });
  await runtime.sessionPrepare({ cwd: '/repo', scope_id, request_id: 'request', value: { route: 'planning' } });
  await runtime.checkpointPut({ cwd: '/repo', scope_id, checkpoint_id: 'checkpoint', value: { step: 1 } });
  await runtime.sessionRecord({
    cwd: '/repo', scope_id, request_id: 'request', idempotency_key: 'record',
    references: [{ logical_id: 'plan-a', status: 'active' }]
  });

  runtime.invalidateScope(scope_id);
  assert.equal([...runtime.sessionState.keys()].some((key) => key.startsWith(`${scope_id}:`)), false);
  assert.equal([...runtime.checkpoints.keys()].some((key) => key.startsWith(`${scope_id}:`)), false);
  assert.equal([...runtime.sessionRecords.keys()].some((key) => key.startsWith(`${scope_id}:`)), false);
});

test('scoped project snapshot asserts and reuses the live scope context and facts', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    loadRules: async () => ({
      routing_rule_version: 1,
      thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
      direct: { deny_patterns: [], allow_rules: [] },
      routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
      skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
    }),
    planProject: async () => { calls.push('plan'); return { eligibility: 'external_project', project_root: '/repo', identity: { kind: 'company', canonical_repository: 'ugnas-gitlab/Org/Repo.git', remote_name: 'origin', project_fingerprint: 'fp' } }; },
    resolveProjectContext: async () => { calls.push('context'); return { status: 'ready', project: { root: '/repo', project_id: 'p1', project_fingerprint: 'fp' }, config_revision: 3, manifest_revision: 4, documentation: { backend: 'wiki' } }; },
    gitPreflight: async () => { calls.push('git'); return { status: 'ready', root: '/repo', branch: { current: 'main', upstream: 'origin/main' }, dirty: false }; },
    scopeFacts: async ({ scope }) => ({
      root: '/repo', git_identity_digest: scope.git_identity_digest, project_fingerprint: 'fp',
      revision: 4, config_revision: 3, config_hash: null, manifest_revision: 4,
      manifest_hash: null, host_config_digest: null, transport_digest: null
    })
  });

  const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' } });
  const snapshot = await runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id });
  assert.equal(snapshot.root, '/repo');
  assert.equal(snapshot.config_revision, 3);
  assert.equal(snapshot.manifest_revision, 4);
  assert.deepEqual(snapshot.remote, {
    status: 'known', remote_name: 'origin', host: 'ugnas-gitlab', path: 'org/repo', upstream: 'origin/main'
  });
  assert.deepEqual(calls, ['plan', 'context', 'git']);
});

test('scoped project snapshot returns stable scope_expired for unknown, mismatched, and changed scopes', async () => {
  let revision = 1;
  const runtime = new HpsRuntime({
    scopeFacts: async () => ({ root: '/repo', revision }),
    projectSnapshot: async () => ({ root: '/repo', identity: { kind: 'external' }, git: { branch: { current: 'main' }, dirty: false } })
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  await assert.rejects(() => runtime.projectSnapshot({ cwd: '/repo', scope_id: 'missing-scope' }), /scope_expired/u);
  await assert.rejects(() => runtime.projectSnapshot({ cwd: '/other', scope_id }), /scope_expired/u);
  revision = 2;
  await assert.rejects(() => runtime.projectSnapshot({ cwd: '/repo', scope_id }), /scope_expired/u);
});

test('default task_prepare scope validator detects changed facts without repeating plan or context resolution', async () => {
  let manifestRevision = 4;
  const calls = [];
  const digest = (value) => createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
  const identity = { kind: 'company', project_fingerprint: 'fp', canonical_repository: 'ugnas-gitlab/org/repo', remote_name: 'origin' };
  const hostConfig = { wiki: { transport: { kind: 'ssh-stdio-mcp', ssh_alias: 'wiki' } } };
  const config = { project_fingerprint: 'fp' };
  const qmdClient = {};
  const runtime = new HpsRuntime({
    loadRules: async () => ({
      routing_rule_version: 1,
      thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
      direct: { deny_patterns: [], allow_rules: [] },
      routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
      skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
    }),
    planProject: async () => { calls.push('plan'); return { eligibility: 'external_project', project_root: '/repo', identity }; },
    resolveProjectContext: async () => {
      calls.push('context');
      const manifest = { revision: 4 };
      return {
        status: 'ready', project: { root: '/repo', project_fingerprint: 'fp' },
        config_revision: 3, config_hash: digest(config), manifest_hash: digest(manifest),
        host_config_digest: digest(hostConfig), transport_digest: digest(hostConfig.wiki.transport),
        documentation: { backend: 'wiki' }, wiki: { manifest, qmd_client: qmdClient }
      };
    },
    projectContextDependencies: {
      identifyGitProject: async () => identity,
      readHostConfig: async () => ({ ok: true, config: hostConfig }),
      defaultHostConfigPath: () => '/host.json',
      resolveWikiProjectConfig: async () => ({
        status: 'ready', config, config_revision: 3, manifest: { revision: manifestRevision }
      })
    },
    gitPreflight: async () => ({ status: 'ready', root: '/repo', branch: { current: 'main', upstream: null }, dirty: false })
  });

  const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' } });
  await runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id });
  manifestRevision = 5;
  await assert.rejects(
    () => runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id }),
    /scope_expired/u
  );
  assert.deepEqual(calls, ['plan', 'context']);
});

test('task_prepare binds verified local identity and config facts including null transitions', async () => {
  const calls = [];
  let localConfig = { version: '4.5.0', documentation: { enabled: true } };
  const runtime = new HpsRuntime({
    loadRules: async () => ({
      routing_rule_version: 1,
      thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
      direct: { deny_patterns: [], allow_rules: [] },
      routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
      skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
    }),
    planProject: async () => { calls.push('plan'); return { eligibility: 'project', project_root: '/repo' }; },
    projectContextDependencies: {
      identifyGitProject: async () => ({ kind: 'external', project_root: '/repo' }),
      readConfigAtRoot: () => localConfig
    },
    gitPreflight: async () => ({ status: 'ready', root: '/repo', branch: { current: 'main', upstream: null }, dirty: false })
  });

  const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' } });
  const snapshot = await runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id });
  assert.equal(snapshot.root, '/repo');
  localConfig = null;
  await assert.rejects(
    () => runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id }),
    /scope_expired/u
  );
  assert.deepEqual(calls, ['plan']);
});

test('unregistered local identity binds config null-to-value changes and expires the scope', async () => {
  let localConfig = null;
  const runtime = new HpsRuntime({
    loadRules: async () => ({
      routing_rule_version: 1,
      thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
      direct: { deny_patterns: [], allow_rules: [] },
      routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
      skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
    }),
    planProject: async () => ({ eligibility: 'project', project_root: '/repo' }),
    projectContextDependencies: {
      identifyGitProject: async () => ({ kind: 'none', project_root: '/repo' }),
      readConfigAtRoot: () => localConfig
    },
    gitPreflight: async () => ({ status: 'ready', root: '/repo', branch: { current: 'main', upstream: null }, dirty: false })
  });
  const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' } });
  await runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id });
  localConfig = { version: '4.5.0', documentation: { enabled: true } };
  await assert.rejects(() => runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id }), /scope_expired/u);
});

test('local task_prepare keeps generic scoped operations live until config facts change', async (t) => {
  const localRules = async () => ({
    routing_rule_version: 1,
    thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
    direct: { deny_patterns: [], allow_rules: [] },
    routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
    skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
  });

  await t.test('an unchanged configured project supports every generic scope consumer', async () => {
    let localConfig = { version: '4.5.0', documentation: { enabled: true } };
    const runtime = new HpsRuntime({
      loadRules: localRules,
      planProject: async () => ({ eligibility: 'project', project_root: '/repo' }),
      projectContextDependencies: {
        identifyGitProject: async () => ({ kind: 'external', project_root: '/repo' }),
        readConfigAtRoot: () => localConfig
      },
      contextCollect: async () => ({ schema_version: 1, branches: {} }),
      runProfile: async () => ({ status: 'passed', exit_code: 0 })
    });

    const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' } });
    const scope_id = prepared.scope.scope_id;
    assert.equal(await runtime.projectContext({ cwd: '/repo', scope_id }), null);
    assert.equal((await runtime.contextCollect({ cwd: '/repo', scope_id, query: 'scope' })).schema_version, 1);
    assert.equal((await runtime.verificationRun({ cwd: '/repo', scope_id, profile: 'hps-unit' })).status, 'passed');
    assert.equal((await runtime.sessionPrepare({ cwd: '/repo', scope_id, request_id: 'local-scope', value: { route: 'planning' } })).status, 'ok');

    localConfig = { version: '4.5.0', documentation: { enabled: false } };
    await assert.rejects(() => runtime.projectContext({ cwd: '/repo', scope_id }), /scope_expired/u);
  });

  await t.test('an unchanged null config remains live but null-to-value expires it', async () => {
    let localConfig = null;
    const runtime = new HpsRuntime({
      loadRules: localRules,
      planProject: async () => ({ eligibility: 'project', project_root: '/repo' }),
      projectContextDependencies: {
        identifyGitProject: async () => ({ kind: 'none', project_root: '/repo' }),
        readConfigAtRoot: () => localConfig
      }
    });

    const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' } });
    const scope_id = prepared.scope.scope_id;
    assert.equal((await runtime.checkpointPut({ cwd: '/repo', scope_id, checkpoint_id: 'local-null', value: { step: 1 } })).status, 'ok');
    localConfig = { version: '4.5.0', documentation: { enabled: true } };
    await assert.rejects(() => runtime.checkpointGet({ cwd: '/repo', scope_id, checkpoint_id: 'local-null' }), /scope_expired/u);
  });
});

test('snapshot scope invalidation closes qmd exactly once while success keeps it live', async (t) => {
  for (const outcome of ['mismatch', 'null', 'error', 'success']) {
    await t.test(outcome, async () => {
      let closed = 0;
      const runtime = new HpsRuntime({
        scopeFacts: async () => {
          if (outcome === 'mismatch') return { root: '/repo', revision: 2 };
          if (outcome === 'null') return null;
          if (outcome === 'error') throw new Error('probe failed');
          return { root: '/repo', revision: 1 };
        },
        gitPreflight: async () => ({ status: 'ready', root: '/repo', branch: { current: 'main', upstream: null }, dirty: false })
      });
      const scope_id = runtime.openScope({
        root: '/repo', revision: 1,
        qmd_client: { close: async () => { closed += 1; } }
      });
      if (outcome === 'success') {
        await runtime.projectSnapshot({ cwd: '/repo', scope_id });
        assert.equal(closed, 0);
      } else {
        await assert.rejects(() => runtime.projectSnapshot({ cwd: '/repo', scope_id }), /scope_expired/u);
        assert.equal(closed, 1);
        await assert.rejects(() => runtime.projectSnapshot({ cwd: '/repo', scope_id }), /scope_expired/u);
        assert.equal(closed, 1);
      }
    });
  }
});

test('scope cleanup continues when qmd close throws synchronously', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo', qmd_client: { close: () => { throw new Error('close failed'); } } });
  runtime.sessionState.set(`${scope_id}:session`, Promise.resolve());
  runtime.checkpoints.set(`${scope_id}:checkpoint`, Promise.resolve());
  runtime.sessionRecords.set(`${scope_id}:record`, Promise.resolve());
  runtime.documentReferences.set(`${scope_id}:ref`, { expires_at: Date.now() + 1000 });
  assert.doesNotThrow(() => runtime.invalidateScope(scope_id));
  assert.equal(runtime.scopes.has(scope_id), false);
  assert.equal([...runtime.sessionState.keys()].some((key) => key.startsWith(`${scope_id}:`)), false);
  assert.equal([...runtime.checkpoints.keys()].some((key) => key.startsWith(`${scope_id}:`)), false);
  assert.equal([...runtime.sessionRecords.keys()].some((key) => key.startsWith(`${scope_id}:`)), false);
  assert.equal([...runtime.documentReferences.keys()].some((key) => key.startsWith(`${scope_id}:`)), false);

  const second = new HpsRuntime();
  const secondScope = second.openScope({ root: '/repo', qmd_client: { close: () => { throw new Error('close failed'); } } });
  second.sessionState.set(`${secondScope}:session`, Promise.resolve());
  await assert.doesNotReject(() => second.close());
  assert.equal(second.sessionState.size, 0);
});

test('scoped snapshot rejects when its scope is invalidated while git facts are pending', async () => {
  let releaseGit;
  const runtime = new HpsRuntime({
    scopeFacts: async () => ({ root: '/repo', revision: 1 }),
    gitPreflight: async () => new Promise((resolve) => { releaseGit = resolve; })
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const pending = runtime.projectSnapshot({ cwd: '/repo', scope_id });
  await new Promise((resolve) => setImmediate(resolve));
  runtime.invalidateScope(scope_id);
  releaseGit({ status: 'ready', root: '/repo', branch: { current: 'main', upstream: null }, dirty: false });
  await assert.rejects(() => pending, /scope_expired/u);
});

test('default snapshot validator rejects each changed Git, config, manifest, and transport fact', async (t) => {
  const digest = (value) => createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
  for (const changedFact of ['git', 'config', 'manifest', 'transport']) {
    await t.test(changedFact, async () => {
      const calls = [];
      const initialIdentity = { kind: 'company', project_fingerprint: 'fp', canonical_repository: 'ugnas-gitlab/org/repo', remote_name: 'origin' };
      const initialConfig = { project_fingerprint: 'fp', revision: 1 };
      const initialManifest = { revision: 4 };
      const initialHost = { wiki: { transport: { kind: 'ssh-stdio-mcp', ssh_alias: 'wiki-a' } } };
      let currentIdentity = initialIdentity;
      let currentConfig = initialConfig;
      let currentManifest = initialManifest;
      let currentHost = initialHost;
      const runtime = new HpsRuntime({
        loadRules: async () => ({
          routing_rule_version: 1,
          thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
          direct: { deny_patterns: [], allow_rules: [] },
          routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
          skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
        }),
        planProject: async () => { calls.push('plan'); return { eligibility: 'external_project', project_root: '/repo', identity: initialIdentity }; },
        resolveProjectContext: async () => {
          calls.push('context');
          return {
            status: 'ready', project: { root: '/repo', project_fingerprint: 'fp' },
            config_revision: 3, config_hash: digest(initialConfig), manifest_hash: digest(initialManifest),
            host_config_digest: digest(initialHost), transport_digest: digest(initialHost.wiki.transport),
            documentation: { backend: 'wiki' }, wiki: { manifest: initialManifest, qmd_client: {} }
          };
        },
        projectContextDependencies: {
          identifyGitProject: async () => currentIdentity,
          readHostConfig: async () => ({ ok: true, config: currentHost }),
          defaultHostConfigPath: () => '/host.json',
          resolveWikiProjectConfig: async () => ({ status: 'ready', config: currentConfig, config_revision: 3, manifest: currentManifest })
        },
        gitPreflight: async () => ({ status: 'ready', root: '/repo', branch: { current: 'main', upstream: 'origin/main' }, dirty: false })
      });

      const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' } });
      await runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id });
      if (changedFact === 'git') currentIdentity = { ...initialIdentity, canonical_repository: 'ugnas-gitlab/org/other' };
      if (changedFact === 'config') currentConfig = { ...initialConfig, revision: 2 };
      if (changedFact === 'manifest') currentManifest = { revision: 5 };
      if (changedFact === 'transport') currentHost = { wiki: { transport: { kind: 'ssh-stdio-mcp', ssh_alias: 'wiki-b' } } };
      await assert.rejects(
        () => runtime.projectSnapshot({ cwd: '/repo', scope_id: prepared.scope.scope_id }),
        /scope_expired/u
      );
      assert.deepEqual(calls, ['plan', 'context']);
    });
  }
});

test('CLI forwards project snapshot scope_id as an operation equivalent', async () => {
  const { call } = await import('../../lib/hps-cli.mjs');
  const seen = [];
  const runtime = { projectSnapshot: async (input) => { seen.push(input); return { root: input.cwd, remote: { status: 'unknown', remote_name: null, host: null, path: null, upstream: null } }; } };
  const response = await call(JSON.stringify({
    schema_version: 1, request_id: 'snapshot-scope', operation: 'project_snapshot', cwd: '/repo', input: { scope_id: 'scope-a' }
  }), runtime);
  assert.equal(response.status, 'ok');
  assert.equal(seen[0].scope_id, 'scope-a');
});
