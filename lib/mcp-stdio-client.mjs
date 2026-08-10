import { spawn } from 'node:child_process';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

const SSH_ALIAS_PATTERN = /^(?!-)[A-Za-z0-9._-]{1,64}$/u;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 262_144;

function failure(errorCode) {
  return { ok: false, error_code: errorCode };
}

function validTransportOptions({ sshAlias, timeoutMs, maxResponseBytes }) {
  return typeof sshAlias === 'string' && SSH_ALIAS_PATTERN.test(sshAlias) &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= MIN_TIMEOUT_MS && timeoutMs <= MAX_TIMEOUT_MS &&
    Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0 && maxResponseBytes <= MAX_RESPONSE_BYTES;
}

class McpStdioSession {
  #child;
  #timeoutMs;
  #maxResponseBytes;
  #nextId = 0;
  #pending = new Map();
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #stdoutBuffer = Buffer.alloc(0);
  #closed = false;
  #fatalError = null;

  constructor(child, { timeoutMs, maxResponseBytes }) {
    this.#child = child;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
  }

  attach() {
    if (!this.#child?.stdin || !this.#child?.stdout || !this.#child?.stderr) {
      this.fail('mcp_spawn_failed');
      return;
    }
    this.#child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    this.#child.stderr.on('data', (chunk) => this.#onStderr(chunk));
    this.#child.stdin.on('error', () => this.fail('mcp_write_failed'));
    this.#child.stdout.once('error', () => this.fail('mcp_connection_closed'));
    this.#child.stderr.once('error', () => this.fail('mcp_connection_closed'));
    this.#child.once('error', () => this.fail('mcp_spawn_failed'));
    this.#child.once('close', (exitCode) => {
      if (!this.#closed && !this.#fatalError) {
        this.fail(exitCode === 0 ? 'mcp_connection_closed' : 'mcp_process_exit', false);
      }
    });
  }

  #onStdout(chunk) {
    this.#stdoutBytes += Buffer.byteLength(chunk);
    if (this.#stdoutBytes > this.#maxResponseBytes) {
      this.fail('mcp_response_too_large');
      return;
    }

    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, Buffer.from(chunk)]);
    while (true) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline === -1) return;
      let lineBytes = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
      if (lineBytes.length === 0) continue;

      let line;
      try {
        line = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
      } catch {
        this.fail('mcp_invalid_json');
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail('mcp_invalid_json');
        return;
      }
      this.#handleMessage(message);
      if (this.#fatalError) return;
    }
  }

  #onStderr(chunk) {
    this.#stderrBytes += Buffer.byteLength(chunk);
    if (this.#stderrBytes > this.#maxResponseBytes) this.fail('mcp_response_too_large');
  }

  #handleMessage(message) {
    if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      this.fail('mcp_invalid_response');
      return;
    }
    if (!Object.hasOwn(message, 'id')) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;

    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message, 'error')) {
      pending.resolve(failure('mcp_rpc_error'));
      return;
    }
    if (!Object.hasOwn(message, 'result')) {
      pending.resolve(failure('mcp_invalid_response'));
      return;
    }
    pending.resolve({ ok: true, result: message.result });
  }

  #write(message) {
    if (this.#fatalError || this.#closed || this.#child.stdin.destroyed) return false;
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`, (writeError) => {
        if (writeError && !this.#closed) this.fail('mcp_write_failed');
      });
      return true;
    } catch {
      this.fail('mcp_write_failed');
      return false;
    }
  }

  request(method, params) {
    if (this.#fatalError) return Promise.resolve(failure(this.#fatalError));
    if (this.#closed) return Promise.resolve(failure('mcp_connection_closed'));

    const id = this.#nextId += 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.fail('mcp_timeout'), this.#timeoutMs);
      this.#pending.set(id, { resolve, timer });
      if (!this.#write({ jsonrpc: '2.0', id, method, params })) {
        const pending = this.#pending.get(id);
        if (pending) {
          this.#pending.delete(id);
          clearTimeout(timer);
          resolve(failure(this.#fatalError ?? 'mcp_write_failed'));
        }
      }
    });
  }

  notify(method, params) {
    return this.#write({ jsonrpc: '2.0', method, params });
  }

  fail(errorCode, terminate = true) {
    if (this.#fatalError) return;
    this.#fatalError = errorCode;
    for (const { resolve, timer } of this.#pending.values()) {
      clearTimeout(timer);
      resolve(failure(errorCode));
    }
    this.#pending.clear();
    if (terminate) this.close();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { resolve, timer } of this.#pending.values()) {
      clearTimeout(timer);
      resolve(failure(this.#fatalError ?? 'mcp_connection_closed'));
    }
    this.#pending.clear();
    try {
      this.#child.stdin.end();
    } catch {
      // The child is already unavailable; no remote output is exposed.
    }
    try {
      this.#child.kill('SIGTERM');
    } catch {
      // The child has already exited.
    }
  }
}

/**
 * A bounded, one-session MCP stdio transport. It never runs a shell and only
 * starts the fixed SSH program with the supplied validated alias.
 */
export class McpStdioClient {
  #sshAlias;
  #timeoutMs;
  #maxResponseBytes;
  #spawnImpl;

  constructor({ sshAlias, timeoutMs, maxResponseBytes }, { spawnImpl = spawn } = {}) {
    this.#sshAlias = sshAlias;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#spawnImpl = spawnImpl;
  }

  /**
   * Start an MCP session, perform the required handshake, and close the
   * process after the callback resolves. Errors intentionally contain only a
   * stable code, never remote stderr or RPC error text.
   */
  async run(callback) {
    if (!validTransportOptions({
      sshAlias: this.#sshAlias,
      timeoutMs: this.#timeoutMs,
      maxResponseBytes: this.#maxResponseBytes
    })) {
      return failure('mcp_invalid_transport_config');
    }

    let child;
    try {
      child = this.#spawnImpl('ssh', ['-T', this.#sshAlias], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      return failure('mcp_spawn_failed');
    }

    const session = new McpStdioSession(child, {
      timeoutMs: this.#timeoutMs,
      maxResponseBytes: this.#maxResponseBytes
    });
    session.attach();
    const lifecycleTimer = setTimeout(() => session.fail('mcp_timeout'), this.#timeoutMs);
    try {
      const initialized = await session.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'horspowers', version: '1' }
      });
      if (!initialized.ok) return initialized;
      if (initialized.result?.protocolVersion !== MCP_PROTOCOL_VERSION) {
        return failure('mcp_protocol_version_mismatch');
      }
      if (!session.notify('notifications/initialized', {})) {
        return failure('mcp_write_failed');
      }
      return await callback(session);
    } catch {
      return failure('mcp_client_failure');
    } finally {
      clearTimeout(lifecycleTimer);
      session.close();
    }
  }
}
