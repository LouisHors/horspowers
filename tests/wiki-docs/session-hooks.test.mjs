import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactsRoot = path.join(repoRoot, 'tests/.artifacts/wiki-docs');
let fixtureSequence = 0;

function localConfig() {
  return [
    'version: 4.5.0',
    'development_mode: team',
    'branch_strategy: worktree',
    'testing_strategy: tdd',
    'completion_strategy: pr',
    'documentation:',
    '  enabled: true',
    ''
  ].join('\n');
}

async function fixture(name, remote) {
  const root = path.join(artifactsRoot, `${Date.now()}-${process.pid}-${fixtureSequence += 1}-${name}`);
  await mkdir(root, { recursive: true });
  await run('git', ['init', '--quiet'], { cwd: root });
  await run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  return root;
}

async function snapshotTree(root) {
  const entries = [];
  async function walk(current, relative = '') {
    const details = await lstat(current);
    if (details.isFile()) {
      entries.push({
        path: relative,
        type: 'file',
        sha256: createHash('sha256').update(await readFile(current)).digest('hex')
      });
      return;
    }
    entries.push({ path: relative, type: details.isDirectory() ? 'directory' : 'other' });
    if (!details.isDirectory()) return;
    const names = await readdir(current);
    for (const name of names.sort()) await walk(path.join(current, name), path.join(relative, name));
  }
  await walk(root);
  return entries;
}

async function runHook(name, { cwd, env = {}, installationRoot = repoRoot }) {
  const child = spawn('bash', [path.join(installationRoot, 'hooks', name)], {
    cwd,
    env: { ...process.env, ...env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  const [exitCode] = await once(child, 'close');
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8')
  };
}

async function fakeRuntime(name) {
  const root = path.join(artifactsRoot, `${Date.now()}-${process.pid}-${fixtureSequence += 1}-${name}-runtime`);
  const pluginRoot = path.join(root, 'plugin');
  const cli = path.join(pluginRoot, 'lib', 'document-runtime-cli.mjs');
  const log = path.join(root, 'requests.jsonl');
  await Promise.all([
    mkdir(path.join(pluginRoot, 'hooks'), { recursive: true }),
    mkdir(path.join(pluginRoot, 'lib'), { recursive: true }),
    mkdir(path.join(pluginRoot, 'skills', 'using-horspowers'), { recursive: true })
  ]);
  await Promise.all([
    copyFile(path.join(repoRoot, 'hooks', 'session-start.sh'), path.join(pluginRoot, 'hooks', 'session-start.sh')),
    copyFile(path.join(repoRoot, 'hooks', 'session-end.sh'), path.join(pluginRoot, 'hooks', 'session-end.sh')),
    copyFile(path.join(repoRoot, 'lib', 'session-hook-runtime.mjs'), path.join(pluginRoot, 'lib', 'session-hook-runtime.mjs')),
    writeFile(path.join(pluginRoot, 'skills', 'using-horspowers', 'SKILL.md'), '# fixture skill\n', 'utf8')
  ]);
  await writeFile(cli, `
import { appendFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
appendFileSync(process.env.HORSPOWERS_FAKE_RUNTIME_LOG, JSON.stringify(request) + '\\n');
if (process.env.HORSPOWERS_FAKE_RUNTIME_STDERR) process.stderr.write(process.env.HORSPOWERS_FAKE_RUNTIME_STDERR);

const mode = process.env.HORSPOWERS_FAKE_RUNTIME_MODE;
let result;
if (request.action === 'resolve') {
  result = mode === 'wiki-ready'
    ? {
        status: 'ready', backend: 'wiki', project_id: 'fixture/wiki',
        identity_status: 'company', config_source: 'wiki', config_status: 'valid',
        documentation_enabled: true
      }
    : mode === 'wiki-unavailable'
      ? {
          status: 'wiki_unavailable', backend: 'disabled', project_id: 'fixture/wiki',
          identity_status: 'company', config_source: 'none', config_status: 'unavailable',
          documentation_enabled: false
        }
      : {
          status: 'ready', backend: 'local', project_id: null,
          identity_status: 'external', config_source: 'local', config_status: 'valid',
          documentation_enabled: true
        };
} else if (request.action === 'record-session') {
  result = { status: 'recorded', backend: 'local', project_id: null };
} else {
  result = { status: 'invalid_request', backend: 'disabled', project_id: null };
}
process.stdout.write(JSON.stringify(result) + '\\n');
`, 'utf8');
  return { cli, log, pluginRoot };
}

async function runtimeRequests(log) {
  try {
    return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function hookContext(result) {
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output?.hookSpecificOutput?.hookEventName === 'SessionStart' ||
    output?.hookSpecificOutput?.hookEventName === 'SessionEnd', true);
  assert.equal(typeof output.hookSpecificOutput.additionalContext, 'string');
  return output.hookSpecificOutput.additionalContext;
}

function assertRuntimeEnvelope(request, action, cwd) {
  assert.deepEqual(Object.keys(request).sort(), ['action', 'confirmed', 'cwd', 'request', 'schema_version']);
  assert.equal(request.schema_version, 1);
  assert.equal(request.cwd, cwd);
  assert.equal(request.action, action);
  assert.equal(request.confirmed, false);
}

test('SessionStart resolves a company Wiki runtime without local initialization markers', async () => {
  const root = await fixture('session-start-wiki', 'git@gitlab.ugnas.com:platform/ugcli-lib.git');
  const runtime = await fakeRuntime('session-start-wiki');
  const fakeHome = path.join(root, 'fake-home');
  await mkdir(fakeHome, { recursive: true });
  await writeFile(path.join(root, '.horspowers-config.yaml'), localConfig(), 'utf8');

  const result = await runHook('session-start.sh', {
    cwd: root,
    installationRoot: runtime.pluginRoot,
    env: {
      HOME: fakeHome,
      HORSPOWERS_FAKE_RUNTIME_LOG: runtime.log,
      HORSPOWERS_FAKE_RUNTIME_MODE: 'wiki-ready'
    }
  });

  const context = hookContext(result);
  assert.match(context, /wiki-ready/u);
  assert.match(context, /config-source=wiki/u);
  assert.doesNotMatch(context, /<config-(?:needs-init|needs-migration|needs-update|invalid)>/u);
  assert.doesNotMatch(context, /<upgrade-needed>/u);

  const requests = await runtimeRequests(runtime.log);
  assert.equal(requests.length, 1);
  assertRuntimeEnvelope(requests[0], 'resolve', root);
  assert.deepEqual(requests[0].request, {});
});

test('SessionStart ignores a document runtime CLI environment override', async () => {
  const root = await fixture('session-start-runtime-override', 'https://github.com/example/session-hook-fixture.git');
  const runtime = await fakeRuntime('session-start-runtime-override');
  const fakeHome = path.join(root, 'fake-home');
  await mkdir(fakeHome, { recursive: true });

  const result = await runHook('session-start.sh', {
    cwd: root,
    env: {
      HOME: fakeHome,
      HORSPOWERS_DOCUMENT_RUNTIME_CLI: runtime.cli,
      HORSPOWERS_FAKE_RUNTIME_LOG: runtime.log,
      HORSPOWERS_FAKE_RUNTIME_MODE: 'wiki-ready'
    }
  });

  hookContext(result);
  assert.deepEqual(await runtimeRequests(runtime.log), []);
});

test('SessionEnd sends only structured session references to the runtime', async () => {
  const root = await fixture('session-end-runtime', 'https://github.com/example/session-hook-fixture.git');
  const runtime = await fakeRuntime('session-end-runtime');
  const fakeHome = path.join(root, 'fake-home');
  const taskDoc = path.join(root, 'docs/active/task-secret.md');
  const bugDoc = path.join(root, 'docs/active/bug-secret.md');
  await mkdir(path.dirname(taskDoc), { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await writeFile(path.join(root, '.horspowers-config.yaml'), localConfig(), 'utf8');
  await writeFile(taskDoc, '# Existing task\n', 'utf8');
  await writeFile(bugDoc, '# Existing bug\n', 'utf8');
  const before = await snapshotTree(root);
  const refs = [
    { document_type: 'task', logical_id: 'task-ref' },
    { document_type: 'bug', logical_id: 'bug-ref' }
  ];

  const result = await runHook('session-end.sh', {
    cwd: root,
    installationRoot: runtime.pluginRoot,
    env: {
      HOME: fakeHome,
      CLAUDE_SESSION_ID: 'opaque-session-id',
      TASK_DOC: taskDoc,
      BUG_DOC: bugDoc,
      HORSPOWERS_SESSION_DOCUMENT_REFS_JSON: JSON.stringify(refs),
      HORSPOWERS_FAKE_RUNTIME_LOG: runtime.log,
      HORSPOWERS_FAKE_RUNTIME_MODE: 'local-ready'
    }
  });

  const context = hookContext(result);
  assert.match(context, /recorded/u);
  assert.deepEqual(await snapshotTree(root), before);

  const requests = await runtimeRequests(runtime.log);
  assert.equal(requests.length, 2);
  assertRuntimeEnvelope(requests[0], 'resolve', root);
  assertRuntimeEnvelope(requests[1], 'record-session', root);
  assert.deepEqual(requests[1].request.document_refs, refs);
  assert.equal(requests[1].request.session.session_id, 'opaque-session-id');
  assert.equal(typeof requests[1].request.session.ended_at, 'string');
  assert.equal(typeof requests[1].request.session.branch, 'string');
  assert.equal(requests[1].request.auto_archive_completed, true);
  const serialized = JSON.stringify(requests[1]);
  assert.equal(serialized.includes(taskDoc), false);
  assert.equal(serialized.includes(bugDoc), false);
  assert.equal(serialized.includes('Existing task'), false);
});

test('SessionEnd derives legacy document names only after a local runtime resolves', async () => {
  const root = await fixture('session-end-local-legacy-refs', 'https://github.com/example/session-hook-fixture.git');
  const runtime = await fakeRuntime('session-end-local-legacy-refs');
  const fakeHome = path.join(root, 'fake-home');
  await mkdir(fakeHome, { recursive: true });

  const result = await runHook('session-end.sh', {
    cwd: root,
    installationRoot: runtime.pluginRoot,
    env: {
      HOME: fakeHome,
      CLAUDE_SESSION_ID: 'opaque-session-id',
      TASK_DOC: path.join(root, 'docs/active/2026-08-10-task-runtime-boundary.md'),
      BUG_DOC: path.join(root, 'docs/active/2026-08-10-bug-runtime-boundary.md'),
      HORSPOWERS_FAKE_RUNTIME_LOG: runtime.log,
      HORSPOWERS_FAKE_RUNTIME_MODE: 'local-ready'
    }
  });

  assert.match(hookContext(result), /recorded/u);
  const requests = await runtimeRequests(runtime.log);
  assert.equal(requests.length, 2);
  assertRuntimeEnvelope(requests[1], 'record-session', root);
  assert.deepEqual(requests[1].request.document_refs, [
    { document_type: 'task', logical_id: 'runtime-boundary' },
    { document_type: 'bug', logical_id: 'runtime-boundary' }
  ]);
  assert.equal(JSON.stringify(requests[1]).includes('docs/active'), false);
});

test('SessionEnd uses the real local runtime to archive completed active documents without explicit references', async () => {
  const root = await fixture('session-end-local-unreferenced-completed', 'https://github.com/example/session-hook-fixture.git');
  const fakeHome = path.join(root, 'fake-home');
  const completed = path.join(root, 'docs', 'active', '2026-08-10-task-unreferenced-completed.md');
  await mkdir(path.dirname(completed), { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await writeFile(path.join(root, '.horspowers-config.yaml'), localConfig(), 'utf8');
  await writeFile(
    completed,
    '# Completed local task\n\n- 状态:已完成\n',
    'utf8'
  );

  const result = await runHook('session-end.sh', {
    cwd: root,
    env: {
      HOME: fakeHome,
      CLAUDE_SESSION_ID: 'opaque-session-id',
      TASK_DOC: '',
      BUG_DOC: '',
      HORSPOWERS_SESSION_DOCUMENT_REFS_JSON: ''
    }
  });

  assert.match(hookContext(result), /recorded/u);
  await assert.rejects(readFile(completed, 'utf8'), { code: 'ENOENT' });
  assert.match(
    await readFile(path.join(root, 'docs', 'archive', path.basename(completed)), 'utf8'),
    /Completed local task/u
  );
});

test('SessionEnd reports unavailable company documentation without runtime stderr leakage', async () => {
  const root = await fixture('session-end-wiki-unavailable', 'ssh://git@gitlab.ugnas.com/platform/ugcli-lib.git');
  const runtime = await fakeRuntime('session-end-wiki-unavailable');
  const fakeHome = path.join(root, 'fake-home');
  await mkdir(fakeHome, { recursive: true });
  await writeFile(path.join(root, '.horspowers-config.yaml'), localConfig(), 'utf8');
  const before = await snapshotTree(root);

  const result = await runHook('session-end.sh', {
    cwd: root,
    installationRoot: runtime.pluginRoot,
    env: {
      HOME: fakeHome,
      CLAUDE_SESSION_ID: 'opaque-session-id',
      HORSPOWERS_FAKE_RUNTIME_LOG: runtime.log,
      HORSPOWERS_FAKE_RUNTIME_MODE: 'wiki-unavailable',
      HORSPOWERS_FAKE_RUNTIME_STDERR: 'RUNTIME_STDERR_SECRET'
    }
  });

  const context = hookContext(result);
  assert.match(context, /wiki-unavailable/u);
  assert.match(context, /not persisted/u);
  assert.equal(context.includes('RUNTIME_STDERR_SECRET'), false);
  assert.deepEqual(await snapshotTree(root), before);

  const requests = await runtimeRequests(runtime.log);
  assert.equal(requests.length, 1);
  assertRuntimeEnvelope(requests[0], 'resolve', root);
});
