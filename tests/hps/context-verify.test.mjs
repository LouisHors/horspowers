import test from 'node:test';
import assert from 'node:assert/strict';

import { HpsRuntime } from '../../lib/hps-runtime.mjs';
import { dispatchHpsOperation } from '../../lib/hps-operations.mjs';

test('project_context and context_collect reuse the scope runtime and reject unscoped access', async () => {
  const calls = [];
  const runtimeContext = {
    status: 'ready', project: { root: '/repo', project_id: 'p1' },
    config_status: 'valid', documentation: { backend: 'wiki', enabled: true },
    wiki: { qmd_client: { internal: true }, host_config: { internal: true } }
  };
  const runtime = new HpsRuntime({
    contextCollect: async (input) => { calls.push(input); return { schema_version: 1, query: input.query, branches: {} }; }
  });
  const scope_id = runtime.openScope({ root: '/repo', document_context: runtimeContext });
  const context = await runtime.projectContext({ cwd: '/repo', scope_id });
  const result = await runtime.contextCollect({ cwd: '/repo', scope_id, query: 'needle' });
  assert.equal(context.project.project_id, 'p1');
  assert.equal(Object.hasOwn(context, 'wiki'), false);
  assert.equal(result.query, 'needle');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, '/repo');
  assert.equal(calls[0].runtime_context, runtimeContext);
  await assert.rejects(() => runtime.contextCollect({ cwd: '/repo', query: 'needle' }), /scope_expired/u);
});

test('context_collect forwards the dispatch abort signal to its collector dependency', async () => {
  let seenSignal;
  const runtime = new HpsRuntime({
    collectContext: async (_input, overrides) => {
      seenSignal = overrides.signal;
      return { schema_version: 1, query: _input.query, branches: {} };
    }
  });
  const scope_id = runtime.openScope({ root: '/repo' });
  const controller = new AbortController();

  await dispatchHpsOperation({
    runtime,
    operation: 'context_collect',
    cwd: '/repo',
    input: { scope_id, query: 'needle' },
    signal: controller.signal
  });

  assert.equal(seenSignal, controller.signal);
});

test('verification_run requires a live scope and accepts only an allowlisted profile', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    runProfile: async (profile) => { calls.push(profile); return { status: 'passed', exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 3 }; }
  });
  const scope_id = runtime.openScope({ root: '/repo' });
  const result = await runtime.verificationRun({ cwd: '/repo', scope_id, profile: 'hps-unit' });
  assert.equal(result.status, 'passed');
  assert.equal(calls[0].id, 'hps-unit');
  await assert.rejects(() => runtime.verificationRun({ cwd: '/repo', profile: 'hps-unit' }), /scope_expired/u);
  await assert.rejects(() => runtime.verificationRun({ cwd: '/repo', scope_id, profile: 'arbitrary-shell' }), /profile|allowlist/i);
  await assert.rejects(() => runtime.verificationRun({ cwd: '/repo', scope_id, profile: 'hps-unit', command: 'rm -rf' }), /command|argv/i);
});
