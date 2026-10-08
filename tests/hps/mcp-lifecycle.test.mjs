import test from 'node:test';
import assert from 'node:assert/strict';

import { HpsMcpServer, runMcpStdio } from '../../lib/hps-mcp-server.mjs';
import { HpsRuntime } from '../../lib/hps-runtime.mjs';

function request(method, id, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

async function ready(server) {
  await server.handle(request('initialize', 'init', { protocolVersion: '2025-06-18' }));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
}

function routingRules() {
  return {
    routing_rule_version: 1,
    thresholds: { explicit: 100, strong_pair: 80, weak: 40, high_confidence: 80, minimum_margin: 10 },
    direct: { deny_patterns: [], allow_rules: [] },
    routes: [{ route: 'brainstorming', skill_map: {}, explicit_patterns: ['design'], strong_groups: [], weak_patterns: [] }],
    skill_map: { brainstorming: 'horspowers:brainstorming' }, conflicts: []
  };
}

test('tools remain blocked until the initialized notification', async () => {
  const server = new HpsMcpServer({ runtime: {} });
  await server.handle(request('initialize', 1));
  assert.equal((await server.handle(request('tools/list', 2))).error.code, -32002);
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  assert.ok((await server.handle(request('tools/list', 3))).result.tools.length > 0);
});

test('duplicate request ids are rejected within one MCP session', async () => {
  let release;
  const runtime = { taskPrepare: async () => new Promise((resolve) => { release = resolve; }) };
  const server = new HpsMcpServer({ runtime });
  await ready(server);
  const first = server.handle(request('tools/call', 'same', { name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'x' } } }));
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await server.handle(request('tools/call', 'same', { name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'x' } } }));
  assert.equal(duplicate.error.code, -32600);
  release({ ok: true });
  await first;
});

test('completed request id history is bounded without evicting active request ids', async () => {
  let release;
  const runtime = {
    taskPrepare: async () => new Promise((resolve) => { release = resolve; })
  };
  const server = new HpsMcpServer({ runtime, maxConcurrent: 1, maxSeenRequestIds: 3 });
  await ready(server);
  const active = server.handle(request('tools/call', 'active-id', {
    name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'x' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  for (const id of ['ping-1', 'ping-2', 'ping-3', 'ping-4']) {
    await server.handle(request('ping', id));
  }
  assert.ok(server.seenRequestIds.size <= 3);
  const duplicate = await server.handle(request('ping', 'active-id'));
  assert.equal(duplicate.error.code, -32600);
  const exhausted = await server.handle(request('ping', 'fresh-after-history-cap'));
  assert.equal(exhausted.error.code, -32600);
  release({ ok: true });
  await active;
});

test('$/cancelRequest aborts a running tool call and returns a canonical cancelled error', async () => {
  const progress = [];
  const runtime = {
    taskPrepare: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    })
  };
  const server = new HpsMcpServer({ runtime, onNotification: (event) => progress.push(event) });
  await ready(server);
  const pending = server.handle(request('tools/call', 'work', {
    name: 'task_prepare',
    arguments: { cwd: '/repo', input: { message: 'x' } },
    _meta: { progressToken: 'progress-1' }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await server.handle({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'work' } });
  const result = await pending;
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.error.code, 'cancelled');
  assert.ok(progress.some((event) => event.method === 'notifications/progress'));
});

test('operation timeout and concurrency overload use stable canonical errors', async () => {
  let calls = 0;
  const runtime = {
    taskPrepare: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, calls === 1 ? 60 : 1));
      return { call: calls };
    }
  };
  const server = new HpsMcpServer({ runtime, maxConcurrent: 1, operationTimeoutMs: 10 });
  await ready(server);
  const first = server.handle(request('tools/call', 'slow', { name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'x' } } }));
  await new Promise((resolve) => setImmediate(resolve));
  const overloaded = await server.handle(request('tools/call', 'extra', { name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'y' } } }));
  assert.equal(overloaded.result.structuredContent.error.code, 'overloaded');
  const timedOut = await first;
  assert.equal(timedOut.result.structuredContent.error.code, 'timeout');
  const stillOverloaded = await server.handle(request('tools/call', 'still-running', {
    name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'z' } }
  }));
  assert.equal(stillOverloaded.result.structuredContent.error.code, 'overloaded');
  await new Promise((resolve) => setTimeout(resolve, 70));
  const afterSettlement = await server.handle(request('tools/call', 'after-settlement', {
    name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'ready' } }
  }));
  assert.equal(afterSettlement.result.isError, false);
});

test('cancellation keeps the concurrency slot until the underlying operation settles and prevents controlled state mutation', async () => {
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo' });
  const assertScope = runtime.assertScope.bind(runtime);
  runtime.assertScope = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return assertScope(...args);
  };
  const server = new HpsMcpServer({ runtime, maxConcurrent: 1, operationTimeoutMs: 1_000 });
  await ready(server);
  const pending = server.handle(request('tools/call', 'cancel-mutation', {
    name: 'session_prepare',
    arguments: { cwd: '/repo', input: { scope_id, request_id: 'state-a', value: { route: 'planning' } } }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await server.handle({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'cancel-mutation' } });
  const cancelled = await pending;
  assert.equal(cancelled.result.structuredContent.error.code, 'cancelled');
  const overloaded = await server.handle(request('tools/call', 'cancel-slot', {
    name: 'runtime_doctor', arguments: { cwd: '/repo', input: {} }
  }));
  assert.equal(overloaded.result.structuredContent.error.code, 'overloaded');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runtime.sessionState.size, 0);
});

test('cancellation before task_prepare commit prevents a late scope from being published or stored', async () => {
  const runtime = new HpsRuntime({
    loadRules: async () => routingRules(),
    planProject: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { eligibility: 'external_project', project_root: '/repo', identity: { kind: 'company' } };
    },
    resolveProjectContext: async () => ({ status: 'ready', project: { root: '/repo' } })
  });
  const server = new HpsMcpServer({ runtime, operationTimeoutMs: 1_000 });
  await ready(server);
  const pending = server.handle(request('tools/call', 'cancel-scope', {
    name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'design this' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  await server.handle({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 'cancel-scope' } });
  const cancelled = await pending;
  assert.equal(cancelled.result.structuredContent.error.code, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(runtime.scopes.size, 0);
});

test('stdio dispatches calls concurrently and preserves each response id', async () => {
  const runtime = {
    taskPrepare: async ({ input }) => {
      await new Promise((resolve) => setTimeout(resolve, input.message === 'slow' ? 30 : 5));
      return { message: input.message };
    }
  };
  const frames = [
    request('initialize', 1),
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    request('tools/call', 'slow', { name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'slow' } } }),
    request('tools/call', 'fast', { name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'fast' } } })
  ].map((frame) => JSON.stringify(frame)).join('\n');
  const input = (async function* () { yield frames; })();
  const output = { value: '', write(chunk) { this.value += chunk; } };
  await runMcpStdio({ input, output, server: new HpsMcpServer({ runtime }) });
  const responses = output.value.trim().split('\n').map((line) => JSON.parse(line)).filter((message) => Object.hasOwn(message, 'id'));
  assert.deepEqual(responses.map((message) => message.id), [1, 'fast', 'slow']);
});

test('frame limit applies to each frame instead of the total input chunk', async () => {
  const line = JSON.stringify(request('ping', 1));
  assert.ok(Buffer.byteLength(line) < 100);
  const input = (async function* () { yield `${line}\n${JSON.stringify(request('ping', 2))}\n`; })();
  const output = { value: '', write(chunk) { this.value += chunk; } };
  await runMcpStdio({ input, output, maxFrameBytes: 100, server: new HpsMcpServer({ runtime: {} }) });
  const responses = output.value.trim().split('\n').map((value) => JSON.parse(value));
  assert.deepEqual(responses.map((response) => response.id), [1, 2]);

  const oversizedInput = (async function* () { yield `${JSON.stringify(request('ping', 3, { padding: 'x'.repeat(200) }))}\n`; })();
  const oversizedOutput = { value: '', write(chunk) { this.value += chunk; } };
  await runMcpStdio({ input: oversizedInput, output: oversizedOutput, maxFrameBytes: 100, server: new HpsMcpServer({ runtime: {} }) });
  assert.equal(JSON.parse(oversizedOutput.value).error.message, 'Frame too large');
});

test('stdio EOF releases runtime scopes after all in-flight calls finish', async () => {
  let closed = 0;
  const runtime = { close: async () => { closed += 1; } };
  const frames = `${JSON.stringify(request('initialize', 1))}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`;
  const input = (async function* () { yield frames; })();
  const output = { value: '', write(chunk) { this.value += chunk; } };
  await runMcpStdio({ input, output, server: new HpsMcpServer({ runtime }) });
  assert.equal(closed, 1);
});

test('shutdown waits for an abort-ignoring operation to settle before closing the runtime', async () => {
  let release;
  let operationSettled = false;
  let closed = 0;
  const runtime = {
    taskPrepare: async () => {
      await new Promise((resolve) => { release = resolve; });
      operationSettled = true;
      return { status: 'late-success' };
    },
    close: async () => {
      assert.equal(operationSettled, true);
      closed += 1;
    }
  };
  const server = new HpsMcpServer({ runtime, operationTimeoutMs: 1_000 });
  await ready(server);
  const call = server.handle(request('tools/call', 'shutdown-work', {
    name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'x' } }
  }));
  await new Promise((resolve) => setImmediate(resolve));
  let shutdownSettled = false;
  const shutdown = server.handle(request('shutdown', 'shutdown')).then((value) => {
    shutdownSettled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false);
  assert.equal(closed, 0);
  release();
  const [callResult, shutdownResult] = await Promise.all([call, shutdown]);
  assert.equal(callResult.result.structuredContent.error.code, 'cancelled');
  assert.equal(shutdownResult.result, null);
  assert.equal(closed, 1);
});

test('stdio EOF waits for a timed-out underlying operation before runtime close', async () => {
  let operationSettled = false;
  let closedAfterSettlement = false;
  const runtime = {
    taskPrepare: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      operationSettled = true;
      return { status: 'late-success' };
    },
    close: async () => { closedAfterSettlement = operationSettled; }
  };
  const frames = [
    request('initialize', 1),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    request('tools/call', 'eof-work', { name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'x' } } })
  ].map((frame) => JSON.stringify(frame)).join('\n');
  const input = (async function* () { yield frames; })();
  const output = { value: '', write(chunk) { this.value += chunk; } };

  await runMcpStdio({
    input, output,
    server: new HpsMcpServer({ runtime, operationTimeoutMs: 5 })
  });

  const response = output.value.trim().split('\n').map((line) => JSON.parse(line))
    .find((message) => message.id === 'eof-work');
  assert.equal(response.result.structuredContent.error.code, 'timeout');
  assert.equal(closedAfterSettlement, true);
});
