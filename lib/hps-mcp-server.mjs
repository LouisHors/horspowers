import { StringDecoder } from 'node:string_decoder';

import { createHpsRuntime } from './hps-runtime.mjs';
import { createError, createResult, isSafeAbsolutePath } from './hps-protocol.mjs';
import { HPS_OPERATION_DEFINITIONS, HpsError, dispatchHpsOperation, exposedHpsTools, normalizeHpsError, operationInputSchema } from './hps-operations.mjs';

const MAX_FRAME_BYTES = 256 * 1024;
// Claude Code currently negotiates the newer MCP revision. Keep the original
// revision for the bundled client while accepting both wire-compatible
// initialize requests.
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-11-25']);

const TOOL_DESCRIPTIONS = Object.freeze({
  task_prepare: 'Classify the request and prepare a verified project scope. Start here for planning or context work; reuse the returned scope_id for subsequent operations.',
  project_snapshot: 'Read a bounded project, Git, documentation, and remote summary. Call after task_prepare when a live scope_id is available; otherwise performs a read-only snapshot.',
  project_context: 'Read the resolved project and documentation context. Requires the live scope_id returned by task_prepare.',
  git_preflight: 'Read-only Git branch, cleanliness, and ahead/behind facts. Provide the live scope_id when available.',
  diff_snapshot: 'Read a bounded staged and unstaged diff summary without file bodies. Provide the live scope_id when available.',
  document_resolve: 'Resolve the configured documentation backend and manifest metadata. Provide the live scope_id when available.',
  document_search: 'Search project documentation using a scope-bound query and intent. Requires scope_id, query, and intent.',
  document_get: 'Read one bounded documentation record by logical_id or opaque document_ref. Requires a live scope_id.',
  document_manifest: 'Read verified documentation manifest metadata without document bodies. Requires a live scope_id.',
  document_verify: 'Verify one documentation record and return metadata only. Requires a live scope_id and logical_id or document_ref.',
  context_collect: 'Collect bounded repository, Git, entry-file, and trusted Wiki context. Requires a live scope_id; use task_prepare first.',
  verification_run: 'Run one allowlisted verification profile inside the existing scope. Requires scope_id and profile.',
  session_prepare: 'Prepare bounded in-memory session control state. Requires a live scope_id and request_id.',
  session_record: 'Record idempotent session references without content. Requires a live scope_id and idempotency_key.',
  checkpoint_get: 'Read bounded control checkpoint state. Requires a live scope_id and checkpoint_id.',
  checkpoint_put: 'Store bounded control checkpoint state. Requires a live scope_id; never send document bodies.',
  commit_preview: 'Plan a read-only commit preview from verified Git facts. Requires a live scope_id.',
  merge_preview: 'Plan a read-only merge preview against an explicit target branch. Requires a live scope_id.',
  runtime_doctor: 'Inspect the runtime capability envelope and metrics. Call when host or sandbox capability status is unknown.'
});

const TOOLS = exposedHpsTools().map(({ name, definition }) => ({
  name,
  description: TOOL_DESCRIPTIONS[name] ?? `Read-only HPS operation ${name}; follow task_prepare first and reuse its scope_id when required.`,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['cwd', 'input'],
    properties: {
      cwd: { type: 'string' },
      input: operationInputSchema(definition)
    }
  },
  annotations: { readOnlyHint: definition.readOnly, destructiveHint: false, openWorldHint: false }
}));

function rpcError(id, code, message, data = undefined) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export class HpsMcpServer {
  constructor({
    runtime = null,
    maxResponseBytes = 256 * 1024,
    maxConcurrent = 8,
    maxSeenRequestIds = 4_096,
    operationTimeoutMs = 30_000,
    onNotification = null
  } = {}) {
    // Persistence is a fact of this in-process sidecar, not a host or request
    // capability. Keep it in a dedicated provenance envelope so it cannot be
    // confused with workspace/network/approval authorization.
    this.runtime = runtime ?? createHpsRuntime({
      sidecarProcessFacts: { source: 'hps-sidecar', verified: true, persistent_session: true }
    });
    this.maxResponseBytes = maxResponseBytes;
    this.maxConcurrent = maxConcurrent;
    this.maxSeenRequestIds = Math.max(maxConcurrent, maxSeenRequestIds);
    this.operationTimeoutMs = operationTimeoutMs;
    this.onNotification = onNotification;
    this.initializeReceived = false;
    this.ready = false;
    this.closed = false;
    this.seenRequestIds = new Set();
    this.pending = new Map();
    this.inFlightOperations = new Set();
    this.active = 0;
    this.runtimeClosePromise = null;
  }

  setNotificationSink(sink) {
    this.onNotification = sink;
  }

  async #closeRuntime() {
    if (!this.runtimeClosePromise) {
      this.runtimeClosePromise = Promise.resolve(this.runtime?.close?.());
    }
    await this.runtimeClosePromise;
  }

  async close() {
    this.closed = true;
    for (const entry of this.pending.values()) entry.stop(new HpsError('cancelled'));
    await Promise.allSettled([...this.inFlightOperations]);
    await this.#closeRuntime();
  }

  #claimRequestId(id) {
    const key = `${typeof id}:${String(id)}`;
    if (this.seenRequestIds.has(key)) return false;
    // A bounded history cannot both evict IDs and guarantee that an old ID
    // is never reused. Once full, fail closed for every new ID until this
    // session is closed; callers must start a fresh MCP session.
    if (this.seenRequestIds.size >= this.maxSeenRequestIds) return false;
    this.seenRequestIds.add(key);
    return true;
  }

  #toolEnvelope(id, error, metrics = {}) {
    const normalized = normalizeHpsError(error);
    return createError({ request_id: String(id) }, normalized.code, normalized.code, {
      category: normalized.category,
      retryable: normalized.retryable,
      required_action: normalized.requiredAction,
      metrics
    });
  }

  #toolResult(id, envelope) {
    const result = { jsonrpc: '2.0', id, result: {
      isError: envelope.status === 'error',
      structuredContent: envelope,
      content: [{ type: 'text', text: JSON.stringify(envelope) }]
    } };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > this.maxResponseBytes) {
      return rpcError(id, -32000, 'Response too large');
    }
    return result;
  }

  async #emitProgress(id, progressToken, event) {
    if (typeof this.onNotification !== 'function') return;
    await this.onNotification({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: progressToken ?? String(id),
        progress: event
      }
    });
  }

  #cancel(id) {
    const entry = this.pending.get(`${typeof id}:${String(id)}`);
    if (!entry) return;
    entry.stop(new HpsError('cancelled'));
  }

  async handle(message) {
    if (this.closed) return rpcError(message?.id ?? null, -32001, 'Server is shut down');
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id ?? null, -32600, 'Invalid Request');
    if (message.method === '$/cancelRequest' || message.method === 'notifications/cancelled') {
      const cancelledId = message.params?.id ?? message.params?.requestId;
      if (cancelledId !== undefined) this.#cancel(cancelledId);
      return null;
    }
    if (message.method === 'notifications/initialized') {
      if (this.initializeReceived) this.ready = true;
      return null;
    }
    const id = message.id ?? null;
    if (Object.hasOwn(message, 'id') && !this.#claimRequestId(id)) return rpcError(id, -32600, 'Duplicate request id');
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (message.method === 'initialize') {
      if (this.initializeReceived) return rpcError(id, -32600, 'Already initialized');
      const requestedProtocol = message.params?.protocolVersion ?? '2025-06-18';
      if (!SUPPORTED_PROTOCOL_VERSIONS.has(requestedProtocol)) {
        return rpcError(id, -32602, 'Unsupported protocol version');
      }
      this.initializeReceived = true;
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: requestedProtocol, capabilities: { tools: {} },
        serverInfo: { name: 'hps', version: '1.0.0' }
      } };
    }
    if (message.method === 'shutdown') {
      await this.close();
      return { jsonrpc: '2.0', id, result: null };
    }
    if (message.method === 'tools/list') {
      if (!this.ready) return rpcError(id, -32002, 'Server is not initialized');
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (message.method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    if (!this.ready) return rpcError(id, -32002, 'Server is not initialized');
    const name = message.params?.name;
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) {
      const definition = HPS_OPERATION_DEFINITIONS[name];
      if (definition?.deferred) {
        return this.#toolResult(id, this.#toolEnvelope(id, new HpsError('operation_unavailable', {
          category: 'routing', requiredAction: 'use_supported_operation'
        })));
      }
      return rpcError(id, -32602, 'Unknown tool');
    }
    if (this.active >= this.maxConcurrent) {
      return this.#toolResult(id, this.#toolEnvelope(id, new HpsError('overloaded', {
        category: 'transport', retryable: true, requiredAction: 'retry_later'
      })));
    }
    const key = `${typeof id}:${String(id)}`;
    const controller = new AbortController();
    let resolveControl;
    let controlFinished = false;
    let timeout;
    const control = new Promise((resolve) => { resolveControl = resolve; });
    const stop = (error) => {
      if (controlFinished) return;
      controlFinished = true;
      clearTimeout(timeout);
      controller.abort();
      resolveControl({ type: 'control', error });
    };
    this.pending.set(key, { controller, stop });
    this.active += 1;
    timeout = setTimeout(() => stop(new HpsError('timeout')), this.operationTimeoutMs);
    let operation;
    try {
      const args = message.params?.arguments ?? {};
      if (!isSafeAbsolutePath(args.cwd) || !args.input || typeof args.input !== 'object' || Array.isArray(args.input)) {
        throw new HpsError('invalid_request', { category: 'validation', requiredAction: 'fix_input' });
      }
      const progressToken = message.params?._meta?.progressToken;
      const dispatched = dispatchHpsOperation({
        runtime: this.runtime,
        operation: name,
        cwd: args.cwd,
        input: args.input,
        signal: controller.signal,
        requestId: String(id),
        onProgress: (event) => this.#emitProgress(id, progressToken, event)
      });
      operation = Promise.resolve(dispatched).then(
        (value) => ({ type: 'success', value }),
        (error) => ({ type: 'error', error })
      ).finally(async () => {
        clearTimeout(timeout);
        this.pending.delete(key);
        this.active -= 1;
        this.inFlightOperations.delete(operation);
        if (this.closed && this.active === 0) await this.#closeRuntime();
      });
      this.inFlightOperations.add(operation);
      const outcome = await Promise.race([operation, control]);
      if (outcome.type !== 'success') throw outcome.error;
      const structuredContent = createResult({ request_id: String(id) }, outcome.value, outcome.value?.metrics ?? {});
      return this.#toolResult(id, structuredContent);
    } catch (error) {
      if (!operation) {
        clearTimeout(timeout);
        this.pending.delete(key);
        this.active -= 1;
        if (this.closed && this.active === 0) await this.#closeRuntime();
      }
      return this.#toolResult(id, this.#toolEnvelope(id, error));
    }
  }
}

export async function runMcpStdio({
  input = process.stdin,
  output = process.stdout,
  server = new HpsMcpServer(),
  maxFrameBytes = MAX_FRAME_BYTES
} = {}) {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  const inFlight = new Set();
  server.setNotificationSink((notification) => {
    output.write(`${JSON.stringify(notification)}\n`);
  });
  const schedule = (message) => {
    const pending = Promise.resolve(server.handle(message)).then((response) => {
      if (response) output.write(`${JSON.stringify(response)}\n`);
    });
    inFlight.add(pending);
    pending.finally(() => inFlight.delete(pending));
  };
  const parseLine = (line) => {
    if (!line.trim()) {
      output.write(`${JSON.stringify(rpcError(null, -32600, 'Empty frame'))}\n`);
      return true;
    }
    if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
      output.write(`${JSON.stringify(rpcError(null, -32000, 'Frame too large'))}\n`);
      return false;
    }
    let message;
    try { message = JSON.parse(line); } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
      return true;
    }
    schedule(message);
    return true;
  };
  try {
    for await (const chunk of input) {
      buffer += decoder.write(Buffer.from(chunk));
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, ''); buffer = buffer.slice(newline + 1);
        if (!parseLine(line)) {
          await Promise.allSettled(inFlight);
          return;
        }
      }
      if (Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) {
        output.write(`${JSON.stringify(rpcError(null, -32000, 'Frame too large'))}\n`);
        await Promise.allSettled(inFlight);
        return;
      }
    }
    buffer += decoder.end();
    if (buffer.trim()) {
      parseLine(buffer.replace(/\r$/u, ''));
    }
    await Promise.allSettled(inFlight);
  } finally {
    await Promise.allSettled(inFlight);
    await server.close();
  }
}
