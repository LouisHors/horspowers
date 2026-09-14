import test from 'node:test';
import assert from 'node:assert/strict';

import { HpsRuntime } from '../../lib/hps-runtime.mjs';

test('session and checkpoint state is scoped in memory and can be read back', async () => {
  const runtime = new HpsRuntime();
  const scopeA = runtime.openScope({ root: '/repo', revision: 1 });
  const scopeB = runtime.openScope({ root: '/repo', revision: 1 });
  const prepared = await runtime.sessionPrepare({ cwd: '/repo', scope_id: scopeA, request_id: 'r1', value: { route: 'planning' } });
  assert.equal(prepared.status, 'ok');
  const checkpoint = await runtime.checkpointPut({ cwd: '/repo', scope_id: scopeA, checkpoint_id: 'cp-1', value: { step: 2 } });
  assert.equal(checkpoint.status, 'ok');
  assert.deepEqual((await runtime.checkpointGet({ cwd: '/repo', scope_id: scopeA, checkpoint_id: 'cp-1' })).value, { step: 2 });
  assert.equal((await runtime.checkpointGet({ cwd: '/repo', scope_id: scopeB, checkpoint_id: 'cp-1' })).status, 'not_found');
});

test('preview operations are read-only and never invoke mutation dependencies', async () => {
  let mutations = 0;
  const runtime = new HpsRuntime({ commit: async () => { mutations += 1; }, gitPreflight: async () => ({ status: 'ready', root: '/repo', branch: { current: 'feature' }, dirty: false, sync: { ahead: 0, behind: 0 }, conflict: false }) });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const commit = await runtime.commitPreview({ cwd: '/repo', scope_id });
  const merge = await runtime.mergePreview({ cwd: '/repo', scope_id, target_branch: 'main' });
  assert.equal(commit.status, 'preview');
  assert.equal(merge.status, 'preview');
  assert.equal(mutations, 0);
});

test('session inputs reject credentials and unbounded values', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  await assert.rejects(() => runtime.sessionPrepare({ cwd: '/repo', scope_id, request_id: 'r1', value: { token: 'secret' } }), /token|credential|unsafe/i);
});
