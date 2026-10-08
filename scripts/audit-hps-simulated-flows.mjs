#!/usr/bin/env node
/**
 * Simulated-call audit for HPS.
 *
 * Drives the documented flows for real: one-shot `hps call`, a live MCP
 * session over stdio, and the controlled compatibility entries. Every check
 * reports what it observed rather than asserting silently, so the output is
 * the evidence.
 *
 * Usage: node scripts/audit-hps-simulated-flows.mjs [repo-root]
 *
 * This is a development tool, not a regression gate: the invariants it found
 * (a linked spelling of the project directory, and a live scope surviving a
 * scoped call on an unregistered project) are pinned by
 * tests/hps/mcp-live-scope.test.mjs and tests/hps/scope-cache.test.mjs. Run
 * this when changing scope lifecycle, the protocol, or host wiring.
 *
 * Exit code 0 means every check passed; 1 lists the failures.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = process.argv[2] ?? process.cwd();
const HPS = path.join(REPO, 'bin', 'hps');
const results = [];

function record(section, name, status, detail) {
  results.push({ section, name, status, detail });
  const mark = status === 'pass' ? 'ok  ' : status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`${mark} [${section}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(section, name, fn, { warnOnly = false } = {}) {
  try {
    const detail = await fn();
    record(section, name, 'pass', detail ?? '');
  } catch (error) {
    record(section, name, warnOnly ? 'warn' : 'fail', error instanceof Error ? error.message : String(error));
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, { cwd, input = null, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: String(error), timedOut }); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

function lastEnvelope(stdout) {
  const envelopes = stdout.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value?.schema_version === 1 && typeof value?.status === 'string' ? [value] : [];
    } catch { return []; }
  });
  return envelopes.at(-1) ?? null;
}

async function hpsCall(operation, cwd, input = {}) {
  const request = JSON.stringify({ schema_version: 1, request_id: `audit-${operation}`, operation, cwd, input });
  const result = await run(process.execPath, [HPS, 'call'], { cwd: REPO, input: request });
  return { ...result, envelope: lastEnvelope(result.stdout) };
}

/** Minimal newline-delimited JSON-RPC client for `hps serve --stdio`. */
class McpSession {
  constructor() { this.child = null; this.buffer = ''; this.pending = new Map(); this.nextId = 0; this.stderr = ''; this.closed = false; }

  static async start(cwd) {
    const session = new McpSession();
    session.child = spawn(process.execPath, [HPS, 'serve', '--stdio'], { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    session.child.stdout.on('data', (chunk) => session.#onData(chunk));
    session.child.stderr.on('data', (chunk) => { session.stderr += chunk; });
    await session.#request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hps-audit', version: '1' }
    });
    session.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    return session;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(message.id);
      if (pending) { this.pending.delete(message.id); pending(message); }
    }
  }

  #request(method, params = {}) {
    const id = `audit-${this.nextId += 1}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 60_000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async listTools() {
    const message = await this.#request('tools/list');
    return message.result?.tools ?? [];
  }

  /** Returns { envelope, rpcError } for one tool call. */
  async callTool(name, cwd, input = {}) {
    const message = await this.#request('tools/call', { name, arguments: { cwd, input } });
    if (message.error) return { envelope: null, rpcError: message.error };
    const text = message.result?.content?.find?.((block) => block.type === 'text')?.text;
    if (typeof text !== 'string') return { envelope: null, rpcError: null, raw: message.result };
    return { envelope: lastEnvelope(text), isError: message.result?.isError === true };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { this.child.kill('SIGTERM'); } catch { return; }
    await new Promise((resolve) => { this.child.once('close', resolve); setTimeout(resolve, 5_000).unref?.(); });
  }
}

async function makeProject(name, { git = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), `hps-audit-${name}-`));
  if (git) {
    await run('git', ['init', '--quiet'], { cwd: root });
    await run('git', ['config', 'user.email', 'audit@example.com'], { cwd: root });
    await run('git', ['config', 'user.name', 'audit'], { cwd: root });
    await writeFile(path.join(root, 'README.md'), `# ${name}\n`, 'utf8');
    await run('git', ['add', '.'], { cwd: root });
    await run('git', ['commit', '--quiet', '-m', 'init'], { cwd: root });
  }
  return root;
}

async function main() {
  const projectA = await makeProject('a');
  const projectB = await makeProject('b');
  const cleanup = [projectA, projectB];

  try {
    // ---------- 1. One-shot CLI: every operation the skill calls scope-free ----
    const scopeFree = ['task_prepare', 'project_snapshot', 'git_preflight', 'diff_snapshot', 'document_resolve', 'runtime_doctor'];
    for (const operation of scopeFree) {
      await check('CLI/scope-free', operation, async () => {
        const { envelope } = await hpsCall(operation, projectA, operation === 'task_prepare' ? { message: '先写失败测试', host: 'pi' } : {});
        expect(envelope, 'no envelope on stdout');
        if (envelope.status !== 'ok') throw new Error(`status=${envelope.status} error=${envelope.error?.code}`);
        return envelope.result?.routing ? `route=${envelope.result.routing.route}` : '';
      });
    }

    // ---------- 2. CLI: scope-required operations cannot cross processes -----
    const prepared = await hpsCall('task_prepare', projectA, { message: '先写失败测试', host: 'pi' });
    const scopeA = prepared.envelope?.result?.scope?.scope_id ?? null;
    await check('CLI/scope', 'task_prepare returns a scope_id', async () => {
      expect(scopeA, 'no scope_id in result.scope');
      return scopeA;
    });
    const scopeRequired = ['project_context', 'document_search', 'document_manifest', 'document_verify',
      'context_collect', 'verification_run', 'session_prepare', 'session_record', 'checkpoint_get',
      'checkpoint_put', 'commit_preview', 'merge_preview'];
    for (const operation of scopeRequired) {
      await check('CLI/scope', `${operation} rejects a foreign scope`, async () => {
        const input = { scope_id: 'a'.repeat(24) };
        if (operation === 'document_search') Object.assign(input, { query: 'x', intent: 'y' });
        if (operation === 'document_verify') Object.assign(input, { logical_id: 'plan-a' });
        if (operation === 'verification_run') Object.assign(input, { profile: 'hps-unit' });
        if (operation === 'session_prepare') Object.assign(input, { request_id: 'r' });
        if (operation === 'session_record') Object.assign(input, { request_id: 'r', idempotency_key: 'k' });
        if (operation === 'checkpoint_get' || operation === 'checkpoint_put') Object.assign(input, { checkpoint_id: 'c' });
        if (operation === 'merge_preview') Object.assign(input, { target_branch: 'main' });
        const { envelope } = await hpsCall(operation, projectA, input);
        expect(envelope?.status === 'error', `expected an error, got ${envelope?.status}`);
        expect(envelope.error.code === 'scope_expired', `expected scope_expired, got ${envelope.error.code}`);
        return envelope.error.code;
      });
    }

    // ---------- 3. CLI: document writes stay unavailable ---------------------
    for (const operation of ['document_change_preview', 'document_change_submit', 'document_transition_preview',
      'document_transition_submit', 'project_bootstrap_preview', 'project_bootstrap_submit']) {
      await check('CLI/deferred', operation, async () => {
        const { envelope } = await hpsCall(operation, projectA, {});
        expect(envelope?.status === 'error', `expected an error, got ${envelope?.status}`);
        expect(envelope.error.code === 'operation_unavailable', `expected operation_unavailable, got ${envelope.error.code}`);
        return envelope.error.code;
      });
    }

    // ---------- 4. CLI: protocol-level error codes ---------------------------
    await check('CLI/protocol', 'unknown operation -> operation_not_found', async () => {
      const { envelope } = await hpsCall('definitely_not_an_operation', projectA, {});
      expect(envelope?.error?.code === 'operation_not_found', `got ${envelope?.error?.code}`);
      return envelope.error.code;
    });
    await check('CLI/protocol', 'flat route-request payload -> invalid_request', async () => {
      const flat = JSON.stringify({ schema_version: 1, host: 'pi', cwd: projectA, message: 'hi', active_route: null });
      const result = await run(process.execPath, [HPS, 'call'], { cwd: REPO, input: flat });
      const envelope = lastEnvelope(result.stdout);
      expect(envelope?.error?.code === 'invalid_request', `got ${envelope?.error?.code}`);
      return envelope.error.code;
    });
    await check('CLI/protocol', 'argv payload -> argv_not_supported', async () => {
      const result = await run(process.execPath, [HPS, 'call', '{"a":1}'], { cwd: REPO });
      const envelope = lastEnvelope(result.stdout);
      expect(envelope?.error?.code === 'argv_not_supported', `got ${envelope?.error?.code}`);
      return envelope.error.code;
    });

    // ---------- 5. MCP session: the live-scope claim -------------------------
    const session = await McpSession.start(REPO);
    cleanup.push({ session });
    let tools = [];
    await check('MCP/session', 'initialize + tools/list', async () => {
      tools = await session.listTools();
      expect(tools.length === 19, `expected 19 tools, got ${tools.length}`);
      return `${tools.length} tools`;
    });
    await check('MCP/session', 'tool descriptions state purpose, precondition and order', async () => {
      const thin = tools.filter((tool) => !tool.description || /^HPS /u.test(tool.description) || tool.description.length < 40);
      expect(thin.length === 0, `${thin.length} thin descriptions: ${thin.map((t) => t.name).slice(0, 3).join(', ')}`);
      const withoutSchema = tools.filter((tool) => !tool.inputSchema?.properties?.cwd);
      expect(withoutSchema.length === 0, `${withoutSchema.length} tools lack a cwd schema`);
      return `${tools.length} descriptions >= 40 chars, all carry cwd`;
    });

    let mcpScope = null;
    await check('MCP/session', 'task_prepare returns a scope_id', async () => {
      const { envelope } = await session.callTool('task_prepare', projectA, { message: '先写失败测试', host: 'pi' });
      mcpScope = envelope?.result?.scope?.scope_id ?? null;
      expect(mcpScope, `no scope_id (status=${envelope?.status} error=${envelope?.error?.code})`);
      return mcpScope;
    });
    for (const operation of scopeFree) {
      if (operation === 'task_prepare') continue;
      await check('MCP/session', `${operation} works in-session`, async () => {
        // Only operations whose schema allows scope_id may receive it.
        const carriesScope = ['project_snapshot', 'document_resolve'].includes(operation);
        const { envelope } = await session.callTool(operation, projectA, carriesScope && mcpScope ? { scope_id: mcpScope } : {});
        expect(envelope?.status === 'ok', `status=${envelope?.status} error=${envelope?.error?.code}`);
        return 'ok';
      });
    }
    for (const [operation, input] of [
      ['project_context', {}],
      ['document_search', { query: 'wiki', intent: 'find docs' }],
      ['context_collect', { query: 'audit' }],
      ['verification_run', { profile: 'hps-unit' }],
      ['session_prepare', { request_id: 'r1', value: { route: 'planning' } }],
      ['session_record', { request_id: 'r2', idempotency_key: 'k1', references: [{ logical_id: 'plan-a' }] }],
      ['checkpoint_put', { checkpoint_id: 'cp1', value: { step: 1 } }],
      ['checkpoint_get', { checkpoint_id: 'cp1' }],
      ['commit_preview', {}],
      ['merge_preview', { target_branch: 'main' }]
    ]) {
      await check('MCP/live-scope', `${operation} reuses the session scope`, async () => {
        expect(mcpScope, 'no session scope to reuse');
        const { envelope } = await session.callTool(operation, projectA, { scope_id: mcpScope, ...input });
        expect(envelope?.status === 'ok', `status=${envelope?.status} error=${envelope?.error?.code}`);
        return envelope.result && typeof envelope.result === 'object'
          ? Object.keys(envelope.result).slice(0, 4).join(',')
          : 'ok (null result)';
      }, { warnOnly: true });
    }

    // ---------- 6. MCP: cross-project isolation -----------------------------
    await check('MCP/isolation', 'two projects do not share a scope', async () => {
      const { envelope } = await session.callTool('project_context', projectB, { scope_id: mcpScope });
      expect(envelope?.status === 'error' && envelope.error.code === 'scope_expired',
        `project B reused project A's scope: status=${envelope?.status} code=${envelope?.error?.code}`);
      return 'scope_expired for the other project';
    });
    await check('MCP/isolation', 'each project keeps its own scope when used with its own cwd', async () => {
      const prepB = await session.callTool('task_prepare', projectB, { message: '先写失败测试', host: 'pi' });
      const scopeB = prepB.envelope?.result?.scope?.scope_id;
      expect(scopeB, `no scope for project B (${prepB.envelope?.error?.code})`);
      const ctxB = await session.callTool('project_context', projectB, { scope_id: scopeB });
      expect(ctxB.envelope?.status === 'ok', `project B context status=${ctxB.envelope?.status} code=${ctxB.envelope?.error?.code}`);
      expect(!JSON.stringify(ctxB.envelope.result ?? null).includes(projectA), 'project A leaked into project B');

      // The cross-project attempt above invalidated A's scope on purpose (a
      // scope bound to another root is not reused), so re-prepare is the
      // documented recovery.
      const prepA = await session.callTool('task_prepare', projectA, { message: '先写失败测试', host: 'pi' });
      const scopeA = prepA.envelope?.result?.scope?.scope_id;
      const ctxA = await session.callTool('project_context', projectA, { scope_id: scopeA });
      expect(ctxA.envelope?.status === 'ok', `project A context status=${ctxA.envelope?.status} code=${ctxA.envelope?.error?.code}`);
      expect(!JSON.stringify(ctxA.envelope.result ?? null).includes(projectB), 'project B leaked into project A');
      return 'both projects hold their own scope';
    });

    // ---------- 7. CLI vs MCP envelope equivalence --------------------------
    await check('equivalence', 'runtime_doctor CLI and MCP agree (except the documented session flag)', async () => {
      const cli = await hpsCall('runtime_doctor', projectA, {});
      const { envelope: mcp } = await session.callTool('runtime_doctor', projectA, {});
      // `persistent_session` is intentionally true only in-process (capability
      // doc: it must come from a verified sidecar), so exclude it from the
      // equivalence comparison and assert the documented difference instead.
      const shape = (envelope) => {
        const capabilities = { ...envelope.result?.capabilities };
        delete capabilities.persistent_session;
        return JSON.stringify({ status: envelope.status, resultKeys: Object.keys(envelope.result ?? {}).sort(), capabilities, protocol: envelope.result?.protocol });
      };
      expect(shape(cli.envelope) === shape(mcp), `CLI=${shape(cli.envelope)} MCP=${shape(mcp)}`);
      expect(cli.envelope.result.capabilities.persistent_session === false, 'CLI must not claim a persistent session');
      expect(mcp.result.capabilities.persistent_session === true, 'the sidecar must report a persistent session');
      return 'equivalent; persistent_session false(CLI)/true(MCP)';
    });

    await check('capabilities', 'fail closed without host facts', async () => {
      const { envelope } = await hpsCall('runtime_doctor', projectA, {});
      const capabilities = envelope.result.capabilities;
      const enabled = Object.entries(capabilities).filter(([, value]) => value === true).map(([key]) => key);
      expect(enabled.length === 0, `unexpectedly enabled: ${enabled.join(', ')}`);
      return `all false; reason=${envelope.result.capability_verification?.reason}`;
    });

    await session.close();

    // ---------- 8. Compatibility entries ------------------------------------
    await check('compat', 'route-request.mjs accepts the flat payload', async () => {
      const flat = JSON.stringify({ schema_version: 1, host: 'pi', cwd: projectA, message: '先写失败测试', active_route: null });
      const script = path.join(REPO, 'skills/using-horspowers/scripts/route-request.mjs');
      const result = await run(process.execPath, [script], { cwd: REPO, input: flat });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.routing?.route === 'tdd', `route=${parsed.routing?.route} stderr=${result.stderr.slice(0, 120)}`);
      return `route=${parsed.routing.route} mutations=${Array.isArray(parsed.mutations) ? parsed.mutations.length : 'none'}`;
    });
    await check('compat', 'document-runtime-cli.mjs resolve works without MCP', async () => {
      const script = path.join(REPO, 'lib/document-runtime-cli.mjs');
      const request = JSON.stringify({ schema_version: 1, cwd: projectA, action: 'resolve', request: {}, confirmed: false });
      const result = await run(process.execPath, [script], { cwd: REPO, input: request });
      const parsed = JSON.parse(result.stdout.trim());
      expect(typeof parsed.status === 'string', `no status: ${result.stdout.slice(0, 120)}`);
      return `status=${parsed.status}`;
    });
    await check('compat', 'collect-context.mjs returns branches', async () => {
      const script = path.join(REPO, 'skills/brainstorming/scripts/collect-context.mjs');
      const request = JSON.stringify({ schema_version: 1, cwd: projectA, query: 'audit', wiki_root: null, known_entry_files: [] });
      const result = await run(process.execPath, [script], { cwd: REPO, input: request, timeoutMs: 60_000 });
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.branches, `no branches: ${result.stdout.slice(0, 120)}`);
      return Object.entries(parsed.branches).map(([key, value]) => `${key}:${value.status}`).join(' ');
    });

    // ---------- 9. Routing semantics ----------------------------------------
    for (const [message, expected] of [
      ['把这段文字翻译成英文', 'direct'],
      ['继续', 'uncertain'],
      ['先写失败测试', 'tdd'],
      ['方案已经批准，拆成实施步骤', 'planning']
    ]) {
      await check('routing', `"${message}" -> ${expected}`, async () => {
        const { envelope } = await hpsCall('task_prepare', projectA, { message, host: 'pi' });
        const route = envelope?.result?.routing?.route;
        expect(route === expected, `got ${route}`);
        return route;
      });
    }
  } finally {
    for (const item of cleanup) {
      if (item?.session) await item.session.close().catch(() => {});
      else if (typeof item === 'string') await rm(item, { recursive: true, force: true });
    }
  }

  const failed = results.filter((r) => r.status === 'fail');
  const warned = results.filter((r) => r.status === 'warn');
  console.log(`\n=== ${results.length - failed.length - warned.length} pass / ${warned.length} warn / ${failed.length} fail ===`);
  for (const item of failed) console.log(`FAIL [${item.section}] ${item.name} — ${item.detail}`);
  for (const item of warned) console.log(`WARN [${item.section}] ${item.name} — ${item.detail}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
