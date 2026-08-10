import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { QmdMcpClient } from '../../lib/qmd-mcp-client.mjs';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-qmd-mcp.mjs');
const EXACT_URI = 'qmd://my-code-wiki/projects/horspowers-registry.md';

function createClient({
  mode = 'success',
  collection = 'my-code-wiki',
  timeoutMs = 1_000,
  maxResponseBytes = 8_192
} = {}) {
  const calls = [];
  const kills = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = spawn(process.execPath, [fixturePath], {
      env: { ...process.env, FAKE_QMD_MCP_MODE: mode },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const kill = child.kill.bind(child);
    child.kill = (...killArgs) => {
      kills.push(killArgs);
      return kill(...killArgs);
    };
    return child;
  };
  return {
    calls,
    kills,
    client: new QmdMcpClient({
      collection,
      transport: {
        ssh_alias: 'localwiki',
        timeout_ms: timeoutMs,
        max_response_bytes: maxResponseBytes
      }
    }, { spawnImpl })
  };
}

test('gets one exact qmd URI through the get tool over a shell-free SSH process', async () => {
  const { client, calls } = createClient();
  const outcome = await client.getExact(EXACT_URI);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result.structuredContent.called_tools, ['get']);
  assert.deepEqual(outcome.result.structuredContent.transport_methods, [
    'initialize',
    'notifications/initialized',
    'tools/list',
    'tools/call'
  ]);
  assert.deepEqual(outcome.result.structuredContent.arguments, {
    file: EXACT_URI,
    fromLine: 1,
    maxLines: 4000,
    lineNumbers: false
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ssh');
  assert.deepEqual(calls[0].args, ['-T', 'localwiki']);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ['pipe', 'pipe', 'pipe']);
});

test('ignores a JSON-RPC response with a different request id', async () => {
  const { client } = createClient({ mode: 'wrong_id_first' });
  const outcome = await client.getExact(EXACT_URI);

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result.structuredContent.called_tools, ['get']);
});

test('uses qmd query only for a bounded topic search', async () => {
  const { client } = createClient();
  const outcome = await client.search({ query: 'MCP transport', intent: 'project context' });

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result.structuredContent.called_tools, ['query']);
  assert.deepEqual(outcome.result.structuredContent.arguments, {
    query: 'MCP transport',
    collections: ['my-code-wiki'],
    intent: 'project context',
    rerank: false
  });
});

test('refuses an exact read URI outside the configured collection without spawning SSH', async () => {
  const { client, calls } = createClient();
  const outcome = await client.getExact('qmd://other-collection/projects/horspowers-registry.md');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error_code, 'qmd_invalid_uri');
  assert.equal(calls.length, 0);
});

test('rejects encoded traversal in an exact read URI without spawning SSH', async () => {
  const { client, calls } = createClient();
  const outcome = await client.getExact('qmd://my-code-wiki/projects/%2e%2e/horspowers-registry.md');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error_code, 'qmd_invalid_uri');
  assert.equal(calls.length, 0);
});

test('rejects an untrusted collection or transport bound before spawning SSH', async () => {
  const invalidCollection = createClient({ collection: 'my-code-wiki\nother' });
  const collectionOutcome = await invalidCollection.client.search({ query: 'topic', intent: 'context' });
  assert.equal(collectionOutcome.ok, false);
  assert.equal(collectionOutcome.error_code, 'qmd_invalid_collection');
  assert.equal(invalidCollection.calls.length, 0);

  const invalidTimeout = createClient({ timeoutMs: 120_001 });
  const timeoutOutcome = await invalidTimeout.client.getExact(EXACT_URI);
  assert.equal(timeoutOutcome.ok, false);
  assert.equal(timeoutOutcome.error_code, 'mcp_invalid_transport_config');
  assert.equal(invalidTimeout.calls.length, 0);

  const invalidLimit = createClient({ maxResponseBytes: 262_145 });
  const limitOutcome = await invalidLimit.client.getExact(EXACT_URI);
  assert.equal(limitOutcome.ok, false);
  assert.equal(limitOutcome.error_code, 'mcp_invalid_transport_config');
  assert.equal(invalidLimit.calls.length, 0);
});

test('fails closed when the read-only tool set is missing get', async () => {
  const { client } = createClient({ mode: 'missing_get' });
  const outcome = await client.getExact(EXACT_URI);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error_code, 'qmd_get_tool_unavailable');
});

test('rejects duplicate or paginated tool listings rather than assuming a trusted complete set', async () => {
  for (const mode of ['duplicate_tool', 'paged_tools']) {
    const { client } = createClient({ mode });
    const outcome = await client.getExact(EXACT_URI);
    assert.equal(outcome.ok, false, mode);
    assert.equal(outcome.error_code, 'qmd_readonly_tools_invalid', mode);
  }
});

test('returns bounded stable errors for malformed, oversized, timed-out, failed, and incompatible MCP sessions', async () => {
  const cases = [
    ['malformed_json', 'mcp_invalid_json'],
    ['oversize_output', 'mcp_response_too_large'],
    ['oversize_stderr', 'mcp_response_too_large'],
    ['timeout', 'mcp_timeout'],
    ['rpc_error', 'mcp_rpc_error'],
    ['exit_nonzero', 'mcp_process_exit']
  ];

  for (const [mode, expectedErrorCode] of cases) {
    const { client, kills } = createClient({ mode, maxResponseBytes: 1_024 });
    const outcome = await client.getExact(EXACT_URI);
    assert.equal(outcome.ok, false, mode);
    assert.equal(outcome.error_code, expectedErrorCode, mode);
    assert.doesNotMatch(JSON.stringify(outcome), /synthetic secret/u, mode);
    if (mode === 'timeout') assert.ok(kills.length > 0, 'timeout must terminate its child process');
  }
});

test('rejects a protocol version other than the fixed MCP version', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return spawn(process.execPath, [fixturePath], {
      env: { ...process.env, FAKE_QMD_MCP_PROTOCOL_VERSION: '2024-11-05' },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  };
  const client = new QmdMcpClient({
    collection: 'my-code-wiki',
    transport: { ssh_alias: 'localwiki', timeout_ms: 1_000, max_response_bytes: 8_192 }
  }, { spawnImpl });

  const outcome = await client.getExact(EXACT_URI);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error_code, 'mcp_protocol_version_mismatch');
  assert.equal(calls.length, 1);
});

test('rejects a response that is not JSON-RPC 2.0', async () => {
  const { client } = createClient({ mode: 'invalid_jsonrpc' });
  const outcome = await client.getExact(EXACT_URI);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error_code, 'mcp_invalid_response');
});
