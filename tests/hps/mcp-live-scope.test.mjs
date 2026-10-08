import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hpsBin = path.join(repoRoot, 'bin', 'hps');

/**
 * End-to-end live-scope coverage over the real stdio sidecar.
 *
 * The in-process suites drive `HpsServer.handle()`, which shares one runtime
 * object and can therefore reuse a scope that a real host would never be able
 * to reuse. Two bugs lived in that gap: `assertScope` compared the requested
 * cwd as a string against the canonical root, and `task_prepare` bound plan
 * placeholders for a project whose eligibility is "skipped" while installing a
 * filesystem verifier. Both expire the scope on the first scoped call, and
 * neither is visible with an in-process server or a synthetic `/repo` path.
 */
class McpSession {
  constructor(child) {
    this.child = child;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  static async start(cwd) {
    const child = spawn(process.execPath, [hpsBin, 'serve', '--stdio'], {
      cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    const session = new McpSession(child);
    child.stdout.on('data', (chunk) => session.#onData(chunk));
    await session.#request('initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-scope-test', version: '1' }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
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
      const settle = this.pending.get(message.id);
      if (settle) { this.pending.delete(message.id); settle(message); }
    }
  }

  #request(method, params = {}) {
    const id = `live-${this.nextId += 1}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within 30s`));
      }, 30_000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async call(name, cwd, input = {}) {
    const message = await this.#request('tools/call', { name, arguments: { cwd, input } });
    if (message.error) throw new Error(`${name} failed: ${message.error.message}`);
    const text = message.result?.content?.find((block) => block.type === 'text')?.text;
    assert.equal(typeof text, 'string', `${name} returned no envelope`);
    const envelope = JSON.parse(text.trim().split('\n').filter(Boolean).at(-1));
    return envelope;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    await new Promise((resolve) => {
      this.child.once('close', resolve);
      setTimeout(resolve, 5_000).unref?.();
    });
  }
}

async function git(dir, args) {
  await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}: ${stderr}`))));
  });
}

async function gitProject(dir) {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '--quiet']);
  await git(dir, ['config', 'user.email', 'live-scope@example.com']);
  await git(dir, ['config', 'user.name', 'live scope']);
  await writeFile(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '--quiet', '-m', 'init']);
}

const cleanups = [];
after(async () => {
  for (const run of cleanups.reverse()) await run().catch(() => {});
});

test('a real sidecar session reuses one scope across scoped calls', async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'hps-live-scope-'));
  cleanups.push(() => rm(base, { recursive: true, force: true }));

  // A linked spelling of the project directory: the host may hand over either
  // form, and macOS `/tmp` behaves the same way.
  const projectReal = path.join(base, 'real-project');
  const projectLink = path.join(base, 'linked-project');
  const otherReal = path.join(base, 'other-project');
  await gitProject(projectReal);
  await symlink(projectReal, projectLink);
  await gitProject(otherReal);
  const canonical = await realpath(projectReal);

  const session = await McpSession.start(repoRoot);
  cleanups.push(() => session.close());

  const prepared = await session.call('task_prepare', projectLink, { message: '先写失败测试', host: 'pi' });
  assert.equal(prepared.status, 'ok', JSON.stringify(prepared.error));
  const scope_id = prepared.result.scope.scope_id;
  assert.ok(scope_id, 'task_prepare must return a scope_id');
  assert.equal(prepared.result.scope.root, canonical, 'the scope must store the canonical root');

  // Every scoped operation must accept the linked spelling in one session.
  const snapshot = await session.call('project_snapshot', projectLink, { scope_id });
  assert.equal(snapshot.status, 'ok', `project_snapshot: ${JSON.stringify(snapshot.error)}`);
  assert.equal(snapshot.result.root, canonical);

  const context = await session.call('project_context', projectLink, { scope_id });
  assert.equal(context.status, 'ok', `project_context: ${JSON.stringify(context.error)}`);

  const resolved = await session.call('document_resolve', projectLink, { scope_id });
  assert.equal(resolved.status, 'ok', `document_resolve: ${JSON.stringify(resolved.error)}`);

  const checkpoint = await session.call('checkpoint_put', projectLink, { scope_id, checkpoint_id: 'live', value: { step: 1 } });
  assert.equal(checkpoint.status, 'ok', `checkpoint_put: ${JSON.stringify(checkpoint.error)}`);
  const read = await session.call('checkpoint_get', projectLink, { scope_id, checkpoint_id: 'live' });
  assert.deepEqual(read.result.value, { step: 1 });

  // A second project gets its own scope, and using one project's scope with
  // another project's cwd still fails closed.
  const otherPrepared = await session.call('task_prepare', otherReal, { message: '先写失败测试', host: 'pi' });
  const otherScope = otherPrepared.result.scope.scope_id;
  const otherContext = await session.call('project_context', otherReal, { scope_id: otherScope });
  assert.equal(otherContext.status, 'ok', `other project_context: ${JSON.stringify(otherContext.error)}`);
  assert.ok(!JSON.stringify(otherContext.result ?? null).includes(canonical), 'projects must not share context');

  const crossed = await session.call('project_context', otherReal, { scope_id });
  assert.equal(crossed.status, 'error');
  assert.equal(crossed.error.code, 'scope_expired');

  // The cross-project attempt expires the scope on purpose; re-preparing is the
  // documented recovery and must produce a working scope again.
  const reprepared = await session.call('task_prepare', projectLink, { message: '先写失败测试', host: 'pi' });
  const recovered = await session.call('project_context', projectLink, { scope_id: reprepared.result.scope.scope_id });
  assert.equal(recovered.status, 'ok', `recovered project_context: ${JSON.stringify(recovered.error)}`);
});
