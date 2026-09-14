import { createHpsRuntime } from './hps-runtime.mjs';
import { HpsError, dispatchHpsOperation, normalizeHpsError } from './hps-operations.mjs';
import {
  HPS_SCHEMA_VERSION, MAX_REQUEST_BYTES, createError, createResult, parseCallRequest, progressEvent
} from './hps-protocol.mjs';

async function readStdin(maxBytes = MAX_REQUEST_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total <= maxBytes) chunks.push(buffer);
  }
  if (total === 0) return { ok: false, code: 'empty_input' };
  if (total > maxBytes) return { ok: false, code: 'input_too_large' };
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function closeQuietly(runtime) {
  try { await runtime?.close?.(); } catch { /* lifecycle cleanup must not mask an envelope */ }
}

async function call(input, runtime = null, { onProgress = null } = {}) {
  const activeRuntime = runtime ?? createHpsRuntime();
  const ownsRuntime = runtime === null;
  let parsed;
  try {
    try {
      parsed = JSON.parse(input);
      parseCallRequest(parsed);
    } catch (error) {
      const candidate = error instanceof HpsError
        ? error
        : new HpsError('invalid_request', { category: 'validation', requiredAction: 'fix_input' });
      const normalized = normalizeHpsError(candidate);
      return createError(parsed, normalized.code, normalized.code, { metrics: {} });
    }
    try {
      const result = await dispatchHpsOperation({
        runtime: activeRuntime,
        operation: parsed.operation,
        cwd: parsed.cwd,
        input: parsed.input,
        requestId: parsed.request_id,
        onProgress: typeof onProgress === 'function'
          ? (event) => onProgress(progressEvent(parsed, event.phase, event.status, event.metrics))
          : null
      });
      return createResult(parsed, result, result?.metrics ?? {});
    } catch (error) {
      const normalized = normalizeHpsError(error);
      return createError(parsed, normalized.code, normalized.code, { metrics: {} });
    }
  } finally {
    if (ownsRuntime) await closeQuietly(activeRuntime);
  }
}

export async function runCli(argv = process.argv.slice(2), runtime = null) {
  if (argv[0] === 'serve' && argv[1] === '--stdio' && argv.length === 2) {
    const { HpsMcpServer, runMcpStdio } = await import('./hps-mcp-server.mjs');
    await runMcpStdio({ server: new HpsMcpServer({ runtime }) });
    return 0;
  }
  if (argv[0] === 'version' && argv[1] === '--json' && argv.length === 2) {
    write({ command: 'hps', schema_version: HPS_SCHEMA_VERSION, version: '1.0.0' });
    return 0;
  }
  if (argv[0] === 'doctor' && argv[1] === '--json' && argv.length === 2) {
    const activeRuntime = runtime ?? createHpsRuntime();
    try {
      try {
        write(createResult({ request_id: null }, await activeRuntime.runtimeDoctor()));
      } catch (error) {
        const normalized = normalizeHpsError(error);
        write(createError(null, normalized.code, normalized.code, { metrics: {} }));
      }
    } finally {
      if (runtime === null) await closeQuietly(activeRuntime);
    }
    return 0;
  }
  if (argv[0] === 'call' && argv.length === 1) {
    const activeRuntime = runtime ?? createHpsRuntime();
    try {
      const input = await readStdin();
      write(input.ok ? await call(input.text, activeRuntime, {
        onProgress: (event) => { process.stderr.write(`${JSON.stringify(event)}\n`); }
      }) : createError(null, input.code, input.code, { metrics: {} }));
    } finally {
      if (runtime === null) await closeQuietly(activeRuntime);
    }
    return 0;
  }
  write(createError(null, argv[0] === 'call' ? 'argv_not_supported' : 'invalid_command'));
  return 64;
}

export { call, readStdin };
