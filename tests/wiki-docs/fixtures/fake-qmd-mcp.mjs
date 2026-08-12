import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const mode = process.env.FAKE_QMD_MCP_MODE ?? 'success';
const protocolVersion = process.env.FAKE_QMD_MCP_PROTOCOL_VERSION ?? '2025-06-18';
const tracePath = process.env.FAKE_QMD_MCP_TRACE_FILE ?? null;
const calledTools = [];
const receivedMethods = [];

function fixturePages() {
  if (mode !== 'fixture_pages') return {};
  try {
    const pages = JSON.parse(process.env.FAKE_QMD_MCP_PAGES_JSON ?? '{}');
    return pages !== null && typeof pages === 'object' && !Array.isArray(pages) ? pages : {};
  } catch {
    return {};
  }
}

const pages = fixturePages();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function error(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function trace(message) {
  if (typeof tracePath !== 'string' || tracePath.length === 0) return;
  try {
    appendFileSync(tracePath, `${JSON.stringify(message)}\n`, 'utf8');
  } catch {
    // Trace collection is test-only and must not affect protocol behavior.
  }
}

function result(id, value) {
  write(mode === 'invalid_jsonrpc' ? { id, result: value } : { jsonrpc: '2.0', id, result: value });
}

function toolList() {
  const names = mode === 'missing_get'
    ? ['query', 'multi_get', 'status']
    : mode === 'duplicate_tool'
      ? ['query', 'get', 'get', 'multi_get', 'status']
    : ['query', 'get', 'multi_get', 'status'];
  return {
    tools: names.map((name) => ({ name })),
    ...(mode === 'paged_tools' ? { nextCursor: 'untrusted-next-page' } : {})
  };
}

function toolResult(name, args) {
  return {
    content: [{
      type: 'text',
      text: mode === 'fixture_pages' && name === 'get'
        ? pages[args?.file]
        : `fixture result for ${name}`
    }],
    structuredContent: {
      called_tools: [...calledTools],
      transport_methods: [...receivedMethods],
      arguments: args,
      ...(mode === 'fixture_pages' && name === 'query' ? { results: [] } : {})
    }
  };
}

function handle(message) {
  trace(message);
  receivedMethods.push(message.method);
  if (mode === 'timeout') return;
  if (mode === 'malformed_json') {
    process.stdout.write('not valid json\n');
    return;
  }
  if (mode === 'oversize_output') {
    process.stdout.write(`${'x'.repeat(4_096)}\n`);
    return;
  }
  if (mode === 'oversize_stderr') {
    process.stderr.write('x'.repeat(4_096));
    return;
  }
  if (mode === 'exit_nonzero') {
    process.exitCode = 23;
    process.exit();
    return;
  }

  if (message.method === 'notifications/initialized') return;
  if (!Object.hasOwn(message, 'id')) return;

  if (message.method === 'initialize') {
    result(message.id, { protocolVersion, capabilities: { tools: {} } });
    return;
  }
  if (message.method === 'tools/list') {
    result(message.id, toolList());
    return;
  }
  if (message.method === 'tools/call') {
    if (mode === 'rpc_error') {
      error(message.id, -32_000, 'synthetic secret must not reach the client');
      return;
    }
    const name = message.params?.name;
    calledTools.push(name);
    if (mode === 'wrong_id_first') error(message.id + 1000, -32_000, 'wrong response id');
    if (name !== 'get' && name !== 'query') {
      error(message.id, -32_601, 'unknown tool');
      return;
    }
    if (mode === 'fixture_pages' && name === 'get' && typeof pages[message.params?.arguments?.file] !== 'string') {
      error(message.id, -32_004, 'fixture page not found');
      return;
    }
    result(message.id, toolResult(name, message.params.arguments));
    return;
  }

  error(message.id, -32_601, 'unknown method');
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try {
    handle(JSON.parse(line));
  } catch {
    process.exitCode = 1;
    process.exit();
  }
});
