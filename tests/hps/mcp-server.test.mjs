import test from 'node:test';
import assert from 'node:assert/strict';

import { HpsMcpServer, runMcpStdio } from '../../lib/hps-mcp-server.mjs';

function request(method, id, params = {}) { return { jsonrpc: '2.0', id, method, params }; }

test('MCP initializes and lists annotated tools', async () => {
  const server = new HpsMcpServer({ runtime: { runtimeDoctor: async () => ({}) } });
  const initialized = await server.handle(request('initialize', 1));
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: {} });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await server.handle(request('tools/list', 2));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'task_prepare' && tool.annotations.readOnlyHint === true));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'document_manifest'));
  assert.ok(listed.result.tools.some((tool) => tool.name === 'document_verify'));
  assert.equal(listed.result.tools.some((tool) => tool.name === 'document_change_submit'), false);
  const prepare = listed.result.tools.find((tool) => tool.name === 'task_prepare');
  assert.ok(prepare.inputSchema.properties.input.properties.known_entry_files);
  assert.ok(prepare.inputSchema.properties.input.properties.wiki_root);
  assert.doesNotMatch(prepare.description, /^HPS\s/iu);
  assert.match(prepare.description, /scope|first|start/iu);
  assert.ok(listed.result.tools.every((tool) => !/^HPS\s/iu.test(tool.description)));
});

test('MCP negotiates the Claude Code protocol revision', async () => {
  const server = new HpsMcpServer({ runtime: { runtimeDoctor: async () => ({}) } });
  const initialized = await server.handle(request('initialize', 'claude-init', {
    protocolVersion: '2025-11-25'
  }));
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  await server.close();
});

test('MCP tools/call uses shared runtime and returns structured result', async () => {
  const calls = [];
  const server = new HpsMcpServer({ runtime: { taskPrepare: async (input) => { calls.push(input); return { answer: 42 }; } } });
  await server.handle(request('initialize', 'init'));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const response = await server.handle(request('tools/call', 'a', { name: 'task_prepare', arguments: { cwd: '/repo', input: { message: 'x' } } }));
  assert.equal(response.result.isError, false);
  assert.deepEqual(response.result.structuredContent.result, { answer: 42 });
  assert.equal(response.result.structuredContent.request_id, 'a');
  assert.equal(calls.length, 1);
});

test('MCP and shared runtime return equivalent task_prepare result', async () => {
  const result = { routing: { route: 'direct' }, metrics: { duration_ms: 1 } };
  const runtime = { taskPrepare: async () => result };
  const server = new HpsMcpServer({ runtime });
  await server.handle(request('initialize', 'init'));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const response = await server.handle(request('tools/call', 'equiv', { name: 'task_prepare', arguments: { cwd: '/repo', input: {} } }));
  assert.deepEqual(response.result.structuredContent.result, result);
  assert.equal(response.result.structuredContent.status, 'ok');
});

test('MCP handles ping, unknown tool, cancellation and malformed requests', async () => {
  const server = new HpsMcpServer({ runtime: {} });
  assert.deepEqual((await server.handle(request('ping', 1))).result, {});
  await server.handle(request('initialize', 'init'));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  assert.equal((await server.handle(request('tools/call', 2, { name: 'nope', arguments: {} }))).error.code, -32602);
  const cancelled = await server.handle(request('notifications/cancelled', null, { requestId: 'x' }));
  assert.equal(cancelled, null);
  assert.equal((await server.handle({ jsonrpc: '1.0', id: 4, method: 'ping' })).error.code, -32600);
});

test('MCP exposes canonical operation_unavailable for known deferred tools', async () => {
  const server = new HpsMcpServer({ runtime: {} });
  await server.handle(request('initialize', 'init'));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const response = await server.handle(request('tools/call', 'deferred', {
    name: 'project_bootstrap_submit', arguments: { cwd: '/repo', input: { token: 'never-echo' } }
  }));
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.error.code, 'operation_unavailable');
  assert.equal(response.result.structuredContent.error.message, 'operation_unavailable');
  assert.doesNotMatch(JSON.stringify(response), /never-echo/iu);
});

test('MCP rejects unsafe cwd paths before runtime dispatch', async () => {
  const calls = [];
  const server = new HpsMcpServer({ runtime: { runtimeDoctor: async (input) => { calls.push(input); return {}; } } });
  await server.handle(request('initialize', 'init'));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const [index, cwd] of ['/repo/../outside', '//network/share', '/repo;touch /tmp/pwned', '/repo\nnext'].entries()) {
    const response = await server.handle(request('tools/call', `unsafe-${index}`, {
      name: 'runtime_doctor', arguments: { cwd, input: {} }
    }));
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.error.code, 'invalid_request');
  }
  assert.equal(calls.length, 0);
});

test('MCP rejects tools before initialization and after shutdown', async () => {
  const server = new HpsMcpServer({ runtime: {} });
  assert.equal((await server.handle(request('tools/list', 1))).error.code, -32002);
  await server.handle(request('initialize', 2));
  assert.equal((await server.handle(request('shutdown', 3))).result, null);
  assert.equal((await server.handle(request('tools/list', 4))).error.code, -32001);
});

test('default MCP Sidecar advertises persistent session capability', async () => {
  const server = new HpsMcpServer();
  const doctor = await server.runtime.runtimeDoctor();
  assert.equal(doctor.capabilities.persistent_session, true);
  await server.close();
});

test('MCP stdio accepts chunked CRLF and EOF frames while keeping stdout protocol-only', async () => {
  const chunks = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\r',
    '\n{"jsonrpc":"2.0","method":"notifications/initialized"}\r\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  ];
  const input = (async function* () { for (const chunk of chunks) yield chunk; })();
  const output = { value: '', write(chunk) { this.value += chunk; } };
  await runMcpStdio({ input, output, server: new HpsMcpServer({ runtime: {} }) });
  const lines = output.value.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].result.protocolVersion, '2025-06-18');
  assert.ok(lines[1].result.tools.some((tool) => tool.name === 'runtime_doctor'));
});

test('MCP stdio preserves UTF-8 JSON text when one character is split across byte chunks', async () => {
  const message = '中文 JSON-RPC';
  let received;
  const runtime = {
    taskPrepare: async ({ input }) => {
      received = input.message;
      return { received: input.message };
    }
  };
  const frames = [
    request('initialize', 1),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    request('tools/call', 2, {
      name: 'task_prepare',
      arguments: { cwd: '/repo', input: { message } }
    })
  ].map((frame) => JSON.stringify(frame)).join('\n');
  const bytes = Buffer.from(frames, 'utf8');
  const characterOffset = bytes.indexOf(Buffer.from('中', 'utf8'));
  assert.notEqual(characterOffset, -1);
  const splitOffset = characterOffset + 1;
  const input = (async function* () {
    yield bytes.subarray(0, splitOffset);
    yield bytes.subarray(splitOffset);
  })();
  const output = { value: '', write(chunk) { this.value += chunk; } };

  await runMcpStdio({ input, output, server: new HpsMcpServer({ runtime }) });

  assert.equal(received, message);
  assert.doesNotMatch(received, /\uFFFD/u);
  const response = output.value.trim().split('\n').map((line) => JSON.parse(line))
    .find((entry) => entry.id === 2);
  assert.equal(response.result.structuredContent.result.received, message);
});

test('MCP stdio flushes an incomplete UTF-8 sequence at EOF as a parse error', async () => {
  const input = (async function* () { yield Buffer.from([0xe4]); })();
  const output = { value: '', write(chunk) { this.value += chunk; } };

  await runMcpStdio({ input, output, server: new HpsMcpServer({ runtime: {} }) });

  const response = JSON.parse(output.value);
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32700);
  assert.equal(response.error.message, 'Parse error');
});
