import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpStdioClient } from '../../lib/mcp-stdio-client.mjs';
import { QmdMcpClient } from '../../lib/qmd-mcp-client.mjs';
import { HpsRuntime } from '../../lib/hps-runtime.mjs';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wiki-docs', 'fixtures', 'fake-qmd-mcp.mjs');
const FIRST_URI = 'qmd://my-code-wiki/projects/a.md';
const SECOND_URI = 'qmd://my-code-wiki/projects/b.md';

function persistentClient({ firstMode = 'success' } = {}) {
  const spawns = [];
  let sequence = 0;
  const spawnImpl = (command, args, options) => {
    const mode = sequence++ === 0 ? firstMode : 'success';
    spawns.push({ command, args, options, mode });
    return spawn(process.execPath, [fixturePath], {
      env: { ...process.env, FAKE_QMD_MCP_MODE: mode },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  };
  return {
    spawns,
    client: new QmdMcpClient({
      collection: 'my-code-wiki',
      transport: { ssh_alias: 'localwiki', timeout_ms: 1_000, max_response_bytes: 16_384 }
    }, { spawnImpl, persistent: true })
  };
}

function scriptedMcpChild({ resultFor = () => ({ ok: true }), stderrFor = () => [] } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.end = () => { child.stdin.destroyed = true; };
  child.kill = () => true;
  const responseBytes = [];
  child.stdin.write = (line, callback) => {
    const message = JSON.parse(line);
    queueMicrotask(() => {
      for (const size of stderrFor(message)) child.stderr.emit('data', Buffer.alloc(size, 0x78));
      if (Object.hasOwn(message, 'id')) {
        const result = message.method === 'initialize'
          ? { protocolVersion: '2025-06-18' }
          : resultFor(message);
        const frame = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
        responseBytes.push(frame.length);
        child.stdout.emit('data', frame);
      }
      callback?.();
    });
    return true;
  };
  return { child, responseBytes };
}

test('persistent stdio bounds each response window instead of cumulative session bytes', async (t) => {
  await t.test('many legal stdout frames remain usable after their total exceeds the frame limit', async () => {
    const scripted = scriptedMcpChild();
    const client = new McpStdioClient({ sshAlias: 'localwiki', timeoutMs: 1_000, maxResponseBytes: 128 }, {
      spawnImpl: () => scripted.child
    });
    const connection = await client.connect();
    assert.equal(connection.ok, true);
    try {
      for (let sequence = 0; sequence < 6; sequence += 1) {
        assert.equal((await connection.session.request('probe', { sequence })).ok, true);
      }
      assert.ok(scripted.responseBytes.every((size) => size <= 128));
      assert.ok(scripted.responseBytes.reduce((total, size) => total + size, 0) > 128);
    } finally {
      connection.close();
    }
  });

  await t.test('bounded stderr may recur across completed responses without accumulating forever', async () => {
    const scripted = scriptedMcpChild({ stderrFor: (message) => Object.hasOwn(message, 'id') ? [220] : [] });
    const client = new McpStdioClient({ sshAlias: 'localwiki', timeoutMs: 1_000, maxResponseBytes: 512 }, {
      spawnImpl: () => scripted.child
    });
    const connection = await client.connect();
    assert.equal(connection.ok, true);
    try {
      assert.equal((await connection.session.request('probe', { sequence: 1 })).ok, true);
      assert.equal((await connection.session.request('probe', { sequence: 2 })).ok, true);
      assert.ok(scripted.responseBytes.reduce((total, size) => total + size, 0) < 512);
      assert.ok(220 * scripted.responseBytes.length > 512);
    } finally {
      connection.close();
    }
  });

  await t.test('one oversized stdout frame and one oversized stderr window still fail closed', async () => {
    const oversizedFrame = scriptedMcpChild({
      resultFor: () => ({ padding: 'x'.repeat(200) })
    });
    const stdoutClient = new McpStdioClient({ sshAlias: 'localwiki', timeoutMs: 1_000, maxResponseBytes: 128 }, {
      spawnImpl: () => oversizedFrame.child
    });
    const stdoutConnection = await stdoutClient.connect();
    assert.equal(stdoutConnection.ok, true);
    try {
      assert.deepEqual(await stdoutConnection.session.request('oversized', {}), {
        ok: false, error_code: 'mcp_response_too_large'
      });
      assert.ok(oversizedFrame.responseBytes.at(-1) > 128);
    } finally {
      stdoutConnection.close();
    }

    const oversizedStderr = scriptedMcpChild({
      stderrFor: (message) => message.method === 'stderr-burst' ? [300, 300] : []
    });
    const stderrClient = new McpStdioClient({ sshAlias: 'localwiki', timeoutMs: 1_000, maxResponseBytes: 512 }, {
      spawnImpl: () => oversizedStderr.child
    });
    const stderrConnection = await stderrClient.connect();
    assert.equal(stderrConnection.ok, true);
    try {
      assert.deepEqual(await stderrConnection.session.request('stderr-burst', {}), {
        ok: false, error_code: 'mcp_response_too_large'
      });
    } finally {
      stderrConnection.close();
    }
  });
});

test('persistent qmd client initializes and lists tools once for multiple reads', async () => {
  const { client, spawns } = persistentClient();
  try {
    const first = await client.getExact(FIRST_URI);
    const second = await client.getExact(SECOND_URI);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(spawns.length, 1);
    const methods = second.result.structuredContent.transport_methods;
    assert.equal(methods.filter((method) => method === 'initialize').length, 1);
    assert.equal(methods.filter((method) => method === 'tools/list').length, 1);
    assert.equal(methods.filter((method) => method === 'tools/call').length, 2);
  } finally {
    await client.close();
  }
});

test('persistent qmd client singleflights identical concurrent reads', async () => {
  const { client, spawns } = persistentClient();
  try {
    const [first, second] = await Promise.all([client.getExact(FIRST_URI), client.getExact(FIRST_URI)]);
    assert.deepEqual(first, second);
    assert.equal(spawns.length, 1);
    assert.equal(first.result.structuredContent.transport_methods.filter((method) => method === 'tools/call').length, 1);
  } finally {
    await client.close();
  }
});

test('persistent qmd client uses collision-free keys for distinct query tuples', async () => {
  const { client, spawns } = persistentClient();
  try {
    const [first, second] = await Promise.all([
      client.search({ query: 'a:b', intent: 'c' }),
      client.search({ query: 'a', intent: 'b:c' })
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(spawns.length, 1);
    assert.equal(second.result.structuredContent.transport_methods.filter((method) => method === 'tools/call').length, 2);
    assert.notDeepEqual(first.result.structuredContent.arguments, second.result.structuredContent.arguments);
  } finally {
    await client.close();
  }
});

test('persistent qmd client reconnects at most once after a connection failure', async () => {
  const { client, spawns } = persistentClient({ firstMode: 'exit_nonzero' });
  try {
    const result = await client.getExact(FIRST_URI);
    assert.equal(result.ok, true);
    assert.equal(spawns.length, 2);
  } finally {
    await client.close();
  }
});

test('scope invalidation closes its persistent qmd client', async () => {
  let closes = 0;
  const qmdClient = { close: async () => { closes += 1; } };
  const runtime = new HpsRuntime();
  const scope_id = runtime.openScope({ root: '/repo', revision: 1, qmd_client: qmdClient });
  runtime.invalidateScope(scope_id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
});
