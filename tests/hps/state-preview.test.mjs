import test from 'node:test';
import assert from 'node:assert/strict';

import { HpsRuntime } from '../../lib/hps-runtime.mjs';

test('session and checkpoint stores require a live scope and expire with bounded TTL', async () => {
  let now = 1_000;
  const runtime = new HpsRuntime({ now: () => now, scopeTtlMs: 50, stateTtlMs: 40 });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  await runtime.sessionPrepare({ cwd: '/repo', scope_id, request_id: 'r1', value: { route: 'planning' } });
  await runtime.checkpointPut({ cwd: '/repo', scope_id, checkpoint_id: 'cp-1', value: { step: 1 } });
  assert.equal((await runtime.checkpointGet({ cwd: '/repo', scope_id, checkpoint_id: 'cp-1' })).status, 'ok');
  now += 41;
  assert.equal((await runtime.checkpointGet({ cwd: '/repo', scope_id, checkpoint_id: 'cp-1' })).status, 'not_found');
  await assert.rejects(
    () => runtime.sessionPrepare({ cwd: '/repo', scope_id: 'made-up', request_id: 'r2', value: {} }),
    /scope_expired/u
  );
});

test('session_record detects idempotency payload conflicts and expires records', async () => {
  let now = 1_000;
  const runtime = new HpsRuntime({ now: () => now, stateTtlMs: 40 });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const base = { cwd: '/repo', scope_id, request_id: 'r1', idempotency_key: 'idem', references: [{ logical_id: 'plan-a', status: 'active' }] };
  const first = await runtime.sessionRecord(base);
  assert.deepEqual(await runtime.sessionRecord(base), first);
  await assert.rejects(
    () => runtime.sessionRecord({ ...base, request_id: 'r2', references: [{ logical_id: 'plan-b', status: 'active' }] }),
    /session_conflict/u
  );
  now += 41;
  const renewed = await runtime.sessionRecord({ ...base, request_id: 'r3' });
  assert.equal(renewed.request_id, 'r3');
});

test('all state inputs reject body, path, URI, and credential carriers', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  for (const value of [
    { body: 'text' }, { path: 'docs/a.md' }, { uri: 'qmd://x/a' }, { token: 'secret' }
  ]) {
    await assert.rejects(
      () => runtime.sessionPrepare({ cwd: '/repo', scope_id, request_id: 'r1', value }),
      /unsafe|body|path|uri|credential/iu
    );
    await assert.rejects(
      () => runtime.checkpointPut({ cwd: '/repo', scope_id, checkpoint_id: 'cp', value }),
      /unsafe|body|path|uri|credential/iu
    );
  }
});

test('state payload rejects untyped body carriers recursively without mutation or echo', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo' });
  const body = 'UNIQUE_STATE_BODY_SHOULD_NOT_ECHO';
  const values = [
    { text: body },
    { source: body },
    { code: 'function example() { return 1; }' },
    { markdown: '# heading\n\nparagraph' },
    { diff: '@@ -1 +1 @@\n-old\n+new' },
    { log: '2026-08-17T10:00:00.000Z INFO request completed' },
    { metadata: [{ carrier: body }] },
    { nested: { items: [{ value: body }] } },
    { link: 'qmd://project/docs/plan' },
    { auth: 'Bearer very-secret-token' },
    { route: 'mailto:user@example.com' },
    { phase: 'urn:isbn:9780000000000' },
    { operation: 'data:text/plain,raw-body' },
    { skill: 'git:repo' },
    { status: 'C:\\repo\\file.md' },
    { route: 'relative/path' },
    { route: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' },
    { phase: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' },
    { operation: 'AKIAIOSFODNN7EXAMPLE' },
    { status: 'BearerSecretTokenABC123' },
    { route: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
    { route: 'AbCdEfGhIjKlMnOpQrStUvWx0123456789' }
  ];
  for (const value of values) {
    const before = { session: runtime.sessionState.size, checkpoints: runtime.checkpoints.size };
    await assert.rejects(
      () => runtime.sessionPrepare({ cwd: '/repo', scope_id, request_id: `r-${runtime.sessionState.size}`, value }),
      (error) => {
        assert.equal(String(error).includes(body), false);
        return /unsafe|state|control|schema|invalid/iu.test(String(error));
      }
    );
    await assert.rejects(
      () => runtime.checkpointPut({ cwd: '/repo', scope_id, checkpoint_id: `cp-${runtime.checkpoints.size}`, value }),
      (error) => {
        assert.equal(String(error).includes(body), false);
        return /unsafe|state|control|schema|invalid/iu.test(String(error));
      }
    );
    assert.deepEqual({ session: runtime.sessionState.size, checkpoints: runtime.checkpoints.size }, before);
  }
});

test('session references reject URI and path carriers in logical ids', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo' });
  for (const logical_id of ['mailto:user@example.com', 'urn:isbn:9780000000000', 'data:text/plain,body', 'git:repo', 'C:\\repo\\file.md', 'relative/path', 'ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef']) {
    const before = runtime.sessionRecords.size;
    await assert.rejects(
      () => runtime.sessionRecord({
        cwd: '/repo', scope_id, request_id: 'request', idempotency_key: `record-${before}-${logical_id.length}`,
        references: [{ logical_id }]
      }),
      (error) => !String(error).includes(logical_id)
    );
    assert.equal(runtime.sessionRecords.size, before);
  }
});

test('opaque runtime ids remain valid control state while credential prefixes stay blocked', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo' });
  await runtime.sessionPrepare({ cwd: '/repo', scope_id, request_id: 'opaque', value: { scope_id } });
  assert.deepEqual((await runtime.checkpointPut({
    cwd: '/repo', scope_id, checkpoint_id: 'opaque-checkpoint', value: { request_id: scope_id }
  })), { status: 'ok', scope_id, checkpoint_id: 'opaque-checkpoint' });
  assert.deepEqual((await runtime.checkpointGet({ cwd: '/repo', scope_id, checkpoint_id: 'opaque-checkpoint' })).value, { request_id: scope_id });
});

test('state reads and idempotent session results are isolated from caller mutation', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo' });
  await runtime.checkpointPut({ cwd: '/repo', scope_id, checkpoint_id: 'cp-mutation', value: { route: 'planning', step: 1 } });
  const checkpointRead = await runtime.checkpointGet({ cwd: '/repo', scope_id, checkpoint_id: 'cp-mutation' });
  checkpointRead.value.route = 'tampered';
  checkpointRead.value.step = 99;
  assert.deepEqual((await runtime.checkpointGet({ cwd: '/repo', scope_id, checkpoint_id: 'cp-mutation' })).value, { route: 'planning', step: 1 });

  const input = {
    cwd: '/repo', scope_id, request_id: 'record-mutation', idempotency_key: 'idem-mutation',
    references: [{ logical_id: 'plan-a', status: 'active', revision: 1 }]
  };
  const first = await runtime.sessionRecord(input);
  first.recorded[0].logical_id = 'tampered';
  first.recorded.push({ logical_id: 'body' });
  const second = await runtime.sessionRecord(input);
  assert.deepEqual(second.recorded, [{ logical_id: 'plan-a', status: 'active', revision: 1 }]);
});

test('state payload rejects cyclic and oversized structures before touching stores', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo' });
  const cyclic = {};
  cyclic.self = cyclic;
  const oversized = { route: 'planning', steps: Array.from({ length: 300 }, (_, index) => index) };
  for (const value of [cyclic, oversized]) {
    const before = { session: runtime.sessionState.size, checkpoints: runtime.checkpoints.size };
    await assert.rejects(
      () => runtime.sessionPrepare({ cwd: '/repo', scope_id, request_id: 'cyclic', value }),
      (error) => !String(error).includes('[object Object]')
    );
    await assert.rejects(
      () => runtime.checkpointPut({ cwd: '/repo', scope_id, checkpoint_id: 'cyclic', value }),
      (error) => !String(error).includes('[object Object]')
    );
    assert.deepEqual({ session: runtime.sessionState.size, checkpoints: runtime.checkpoints.size }, before);
  }
});

test('session references reject untyped status, revision, and extra fields', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo' });
  for (const reference of [
    { logical_id: 'plan-a', status: { text: 'active' } },
    { logical_id: 'plan-a', revision: '4' },
    { logical_id: 'plan-a', status: 'active', note: 'free form' }
  ]) {
    await assert.rejects(
      () => runtime.sessionRecord({
        cwd: '/repo', scope_id, request_id: 'request', idempotency_key: 'record', references: [reference]
      }),
      /reference|invalid|unsafe/iu
    );
  }
});

test('commit and merge previews contain Git facts and stable plan digests without mutation', async () => {
  let mutations = 0;
  const runtime = new HpsRuntime({
    gitPreflight: async () => ({
      status: 'ready', root: '/repo', branch: { current: 'feature/x', upstream: 'origin/feature/x' },
      dirty: true, sync: { ahead: 2, behind: 1 }, conflict: false
    }),
    commit: async () => { mutations += 1; },
    merge: async () => { mutations += 1; }
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const first = await runtime.commitPreview({ cwd: '/repo', scope_id });
  const second = await runtime.commitPreview({ cwd: '/repo', scope_id });
  const merge = await runtime.mergePreview({ cwd: '/repo', scope_id, target_branch: 'main' });
  assert.equal(first.branch.current, 'feature/x');
  assert.equal(first.dirty, true);
  assert.match(first.plan_digest, /^[0-9a-f]{64}$/u);
  assert.equal(first.plan_digest, second.plan_digest);
  assert.notEqual(first.plan_digest, merge.plan_digest);
  assert.equal(mutations, 0);
});
