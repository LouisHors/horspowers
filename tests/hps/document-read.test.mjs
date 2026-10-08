import test from 'node:test';
import assert from 'node:assert/strict';

import { HpsRuntime } from '../../lib/hps-runtime.mjs';

test('document read operations delegate to one shared runtime and cache exact reads', async () => {
  const calls = [];
  const runtime = new HpsRuntime({
    documentExecute: async (request) => { calls.push(request); return { status: 'ok', backend: 'local', document: { id: request.request.logical_id } }; }
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const first = await runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { logical_id: 'plan-a' } });
  const second = await runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { logical_id: 'plan-a' } });
  assert.deepEqual(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'get');
});

test('document read does not accept arbitrary URI or collection overrides', async () => {
  const runtime = new HpsRuntime({ documentExecute: async () => ({ status: 'ok' }) });
  await assert.rejects(() => runtime.documentRead({ cwd: '/repo', action: 'get', request: { uri: 'qmd://evil/x.md' } }), /uri|collection|scope/i);
});

test('document read does not publish a delayed result after its scope is invalidated', async () => {
  let release;
  const runtime = new HpsRuntime({
    documentExecute: async () => new Promise((resolve) => { release = resolve; })
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const pending = runtime.documentRead({ cwd: '/repo', action: 'search', scope_id, request: { query: 'plans' } });
  await new Promise((resolve) => setImmediate(resolve));

  runtime.invalidateScope(scope_id);
  release({ status: 'ok', backend: 'local', documents: [{ path: '/repo/docs/plan.md' }] });

  await assert.rejects(() => pending, /scope_expired/u);
  assert.equal(runtime.documentCache.size, 0);
  assert.equal(runtime.documentReferences.size, 0);
});

test('an old delayed read cannot publish over a replacement scope singleflight', async () => {
  const releases = [];
  let calls = 0;
  const runtime = new HpsRuntime({
    documentExecute: async () => {
      calls += 1;
      return new Promise((resolve) => releases.push(resolve));
    }
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  const oldScope = runtime.scopes.get(scope_id);
  const oldPending = runtime.documentRead({ cwd: '/repo', action: 'search', scope_id, request: { query: 'plans' } });
  await new Promise((resolve) => setImmediate(resolve));

  runtime.invalidateScope(scope_id);
  const replacementId = runtime.openScope({ root: '/repo', revision: 1 });
  const replacementScope = runtime.scopes.get(replacementId);
  runtime.scopes.delete(replacementId);
  runtime.scopes.set(scope_id, replacementScope);
  const newPending = runtime.documentRead({ cwd: '/repo', action: 'search', scope_id, request: { query: 'plans' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);

  releases[0]({ status: 'ok', backend: 'local', documents: [{ path: '/repo/docs/old.md' }] });
  await assert.rejects(() => oldPending, /scope_expired/u);
  assert.equal(runtime.scopes.get(scope_id), replacementScope);

  releases[1]({ status: 'ok', backend: 'local', documents: [{ path: '/repo/docs/new.md' }] });
  const fresh = await newPending;
  assert.equal(Object.hasOwn(fresh.documents[0], 'path'), false);
  assert.equal(runtime.scopes.get(scope_id), replacementScope);
  assert.equal(runtime.documentReferences.size, 1);
  assert.equal([...runtime.documentReferences.values()][0].path, '/repo/docs/new.md');

  const cached = await runtime.documentRead({ cwd: '/repo', action: 'search', scope_id, request: { query: 'plans' } });
  assert.deepEqual(cached, fresh);
  assert.equal(calls, 2);
  assert.notEqual(runtime.scopes.get(scope_id), oldScope);
});

test('a cache hit revalidates its scope before returning after an invalidation race', async () => {
  let validation;
  let validationCalls = 0;
  const runtime = new HpsRuntime({
    scopeFacts: async () => {
      validationCalls += 1;
      if (validationCalls === 3) return new Promise((resolve) => { validation = resolve; });
      return { root: '/repo', revision: 1 };
    },
    documentExecute: async () => ({ status: 'ok', backend: 'local', document: { logical_id: 'plan-a' } })
  });
  const scope_id = runtime.openScope({ root: '/repo', revision: 1 });
  await runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { logical_id: 'plan-a' } });

  const cachedRead = runtime.documentRead({ cwd: '/repo', action: 'get', scope_id, request: { logical_id: 'plan-a' } });
  await new Promise((resolve) => setImmediate(resolve));
  runtime.invalidateScope(scope_id);
  validation({ root: '/repo', revision: 1 });

  await assert.rejects(() => cachedRead, /scope_expired/u);
  assert.equal(runtime.documentCache.size, 0);
});
