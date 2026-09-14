import test from 'node:test';
import assert from 'node:assert/strict';

import { HpsRuntime } from '../../lib/hps-runtime.mjs';
import { dispatchHpsOperation } from '../../lib/hps-operations.mjs';

function rules() {
  return {
    routing_rule_version: 1,
    thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
    direct: { deny_patterns: [], allow_rules: [{ id: 'help', any_patterns: ['hello'] }] },
    routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
    skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
  };
}

test('direct task_prepare returns route without resolving context or collecting', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    loadRules: async () => rules(),
    planProject: async () => { calls.push('plan'); return { eligibility: 'external_project' }; },
    resolveProjectContext: async () => { calls.push('resolve'); return {}; },
    collectContext: async () => { calls.push('collect'); return {}; }
  });
  const result = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'hello', host: 'codex' } });
  assert.equal(result.routing.route, 'direct');
  assert.equal(result.routing.target_skill, null);
  assert.deepEqual(calls, []);
  assert.ok(result.metrics.duration_ms >= 0);
});

test('slow task_prepare resolves project context once and collects in parallel', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    loadRules: async () => rules(),
    planProject: async () => { calls.push('plan'); return { eligibility: 'external_project', project_root: '/repo', identity: { kind: 'company' } }; },
    resolveProjectContext: async () => { calls.push('resolve'); return { status: 'ready', project: { project_id: 'p1' }, documentation: { backend: 'wiki' } }; },
    collectContext: async () => { calls.push('collect'); return { branches: {} }; },
    capabilities: { workspace_read: true, workspace_write: false, external_network: false }
  });
  const result = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this', host: 'codex' } });
  assert.equal(result.routing.route, 'brainstorming');
  assert.equal(result.context.status, 'ready');
  assert.deepEqual(calls, ['plan', 'resolve', 'collect']);
  assert.equal(result.capabilities.external_network, false);
  assert.ok(Array.isArray(result.next_actions));
});

test('task_prepare forwards bounded entries but only a scope-trusted Wiki root', async () => {
  let collected;
  const runtime = new HpsRuntime({
    planProject: async () => ({ project_root: '/repo', eligibility: 'external_project', identity: { kind: 'external' } }),
    resolveProjectContext: async () => ({
      status: 'ready', identity_status: 'external', project: { root: '/repo' },
      wiki_root: '/trusted/wiki', wiki_root_trusted: true,
      wiki_root_provenance: {
        source: 'validated_host_config', field: 'wiki.local_root', collection: 'my-code-wiki', canonical: true
      }
    }),
    collectContext: async (input) => { collected = input; return { branches: {} }; },
    loadRules: async () => rules()
  });
  await runtime.taskPrepare({ cwd: '/repo', input: {
    message: 'brainstorm design', known_entry_files: ['/repo/README.md'], wiki_root: '/request-controlled/wiki'
  }});
  assert.deepEqual(collected.known_entry_files, ['/repo/README.md']);
  assert.equal(collected.wiki_root, '/trusted/wiki');
});

test('cancelled task_prepare closes an uncommitted qmd client before publishing a scope', async () => {
  const controller = new AbortController();
  let closed = 0;
  const qmdClient = { close: async () => { closed += 1; } };
  const runtime = new HpsRuntime({
    loadRules: async () => rules(),
    planProject: async () => ({ project_root: '/repo', eligibility: 'external_project', identity: { kind: 'company' } }),
    resolveProjectContext: async () => ({
      status: 'ready', project: { root: '/repo' }, wiki: { qmd_client: qmdClient }
    }),
    collectContext: async () => {
      controller.abort();
      return { branches: {} };
    }
  });

  await assert.rejects(
    () => runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' }, signal: controller.signal }),
    /cancelled/iu
  );
  assert.equal(runtime.scopes.size, 0);
  assert.equal(closed, 1);
});

test('cancelled task_prepare invalidates a scope opened before response publication and closes qmd once', async () => {
  const controller = new AbortController();
  let closed = 0;
  const qmdClient = { close: async () => { closed += 1; } };
  const runtime = new HpsRuntime({
    loadRules: async () => rules(),
    planProject: async () => ({ project_root: '/repo', eligibility: 'external_project', identity: { kind: 'company' } }),
    resolveProjectContext: async () => ({
      status: 'ready', project: { root: '/repo' }, wiki: { qmd_client: qmdClient }
    }),
    collectContext: async () => ({ branches: {} })
  });
  const openScope = runtime.openScope.bind(runtime);
  runtime.openScope = (facts) => {
    const scopeId = openScope(facts);
    controller.abort();
    return scopeId;
  };

  await assert.rejects(
    () => runtime.taskPrepare({ cwd: '/repo', input: { message: 'design this' }, signal: controller.signal }),
    /cancelled/iu
  );
  assert.equal(runtime.scopes.size, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('dispatch cancellation after task_prepare publishes a scope invalidates that scope before returning', async () => {
  const controller = new AbortController();
  let closed = 0;
  const qmdClient = { close: async () => { closed += 1; } };
  const runtime = new HpsRuntime({
    loadRules: async () => rules(),
    planProject: async () => ({ project_root: '/repo', eligibility: 'external_project', identity: { kind: 'company' } }),
    resolveProjectContext: async () => ({
      status: 'ready', project: { root: '/repo' }, wiki: { qmd_client: qmdClient }
    }),
    collectContext: async () => ({ branches: {} })
  });
  const prepare = runtime.taskPrepare.bind(runtime);
  runtime.taskPrepare = async (args) => {
    const result = await prepare(args);
    queueMicrotask(() => controller.abort());
    return result;
  };

  await assert.rejects(
    () => dispatchHpsOperation({
      runtime, operation: 'task_prepare', cwd: '/repo', input: { message: 'design this' }, signal: controller.signal
    }),
    /cancelled/iu
  );
  assert.equal(runtime.scopes.size, 0);
  assert.equal(closed, 1);
});

test('context_collect cannot promote a request Wiki root beyond the live scope facts', async () => {
  let collected;
  const runtime = new HpsRuntime({
    planProject: async () => ({ project_root: '/repo', eligibility: 'external_project', identity: { kind: 'external' } }),
    resolveProjectContext: async () => ({ status: 'ready', identity_status: 'external', project: { root: '/repo' } }),
    collectContext: async (input) => { collected = input; return { branches: {} }; },
    loadRules: async () => rules()
  });
  const prepared = await runtime.taskPrepare({ cwd: '/repo', input: { message: 'write a plan' } });

  await runtime.contextCollect({
    cwd: '/repo', scope_id: prepared.scope.scope_id, query: 'needle', wiki_root: '/request-controlled/wiki'
  });

  assert.equal(collected.wiki_root, null);
});

test('project snapshot is read-only and uses fixed dependency operations', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    projectSnapshot: async ({ cwd }) => { calls.push(cwd); return { root: cwd, identity: { kind: 'external' }, git: { branch: 'main', dirty: false } }; }
  });
  const result = await runtime.projectSnapshot({ cwd: '/repo' });
  assert.equal(result.git.branch, 'main');
  assert.deepEqual(calls, ['/repo']);
});

test('progress callback failures are isolated from dispatch envelopes', async () => {
  const runtime = { runtimeDoctor: async () => ({ capabilities: {}, metrics: {} }) };
  const statuses = [];
  const result = await dispatchHpsOperation({
    runtime, operation: 'runtime_doctor', cwd: '/repo', input: {},
    onProgress: async ({ status }) => {
      statuses.push(status);
      throw new Error('progress sink failed');
    }
  });
  assert.deepEqual(result, { capabilities: {}, metrics: {} });
  assert.deepEqual(statuses, ['started', 'completed']);
});

test('progress callback failures do not replace normalized operation errors', async () => {
  const runtime = { runtimeDoctor: async () => { throw new Error('timeout'); } };
  await assert.rejects(
    () => dispatchHpsOperation({
      runtime, operation: 'runtime_doctor', cwd: '/repo', input: {},
      onProgress: () => { throw new Error('progress sink failed'); }
    }),
    (error) => error.code === 'timeout'
  );
});
