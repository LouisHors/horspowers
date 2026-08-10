import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile } from 'node:fs/promises';
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

function teamConfig() {
  return 'version: 4.5.0\ndevelopment_mode: team\nbranch_strategy: worktree\ntesting_strategy: tdd\ncompletion_strategy: pr\ndocumentation:\n  enabled: true\n';
}

async function retainedCompanyFixture(name) {
  const root = path.join(artifactsRoot, `${Date.now()}-${process.pid}-${fixtureSequence += 1}-${name}`);
  await mkdir(root, { recursive: true });
  await run('git', ['init', '--quiet'], { cwd: root });
  await run('git', ['remote', 'add', 'origin', 'git@gitlab.ugnas.com:platform/ugcli-lib.git'], { cwd: root });
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
    if (details.isDirectory()) {
      for (const name of await readdir(current)) {
        await walk(path.join(current, name), path.join(relative, name));
      }
    }
  }

  await walk(root);
  return entries;
}

async function runHook(name, { cwd, env = {} }) {
  const child = spawn('bash', [path.join(repoRoot, 'hooks', name)], {
    cwd,
    env: { ...process.env, ...env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, 'close');
  return { exitCode, stdout, stderr };
}

test('SessionStart leaves a company project mutation-free while reporting its unavailable Wiki runtime', async () => {
  const root = await retainedCompanyFixture('session-start-company');
  const fakeHome = path.join(root, 'fake-home');
  await mkdir(path.join(root, 'docs/active'), { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await writeFile(path.join(root, '.horspowers-config.yaml'), teamConfig(), 'utf8');
  await writeFile(path.join(root, 'docs/active/task.md'), '# Existing task\n', 'utf8');

  const before = await snapshotTree(root);
  const result = await runHook('session-start.sh', { cwd: root, env: { HOME: fakeHome } });
  const after = await snapshotTree(root);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(after, before);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /wiki-unavailable/u);
  assert.doesNotMatch(context, /external-document-runtime-not-ready/u);
  assert.doesNotMatch(context, /<config-(?:needs-init|needs-migration|needs-update|invalid|valid)>/);
  assert.doesNotMatch(context, /<upgrade-needed>/);
});

test('SessionEnd does not mutate company project documentation when its Wiki runtime is unavailable', async () => {
  const root = await retainedCompanyFixture('session-end-company');
  const fakeHome = path.join(root, 'fake-home');
  const taskDoc = path.join(root, 'docs/active/task.md');
  const bugDoc = path.join(root, 'docs/active/bug.md');
  await mkdir(path.dirname(taskDoc), { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await writeFile(path.join(root, '.horspowers-config.yaml'), 'documentation.enabled: true\n', 'utf8');
  await writeFile(taskDoc, '# Existing task\n', 'utf8');
  await writeFile(bugDoc, '# Existing bug\n', 'utf8');

  const before = await snapshotTree(root);
  const result = await runHook('session-end.sh', {
    cwd: root,
    env: { HOME: fakeHome, TASK_DOC: taskDoc, BUG_DOC: bugDoc, CLAUDE_SESSION_ID: 'test-session' }
  });
  const after = await snapshotTree(root);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(after, before);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /wiki-unavailable/u);
  assert.doesNotMatch(context, /external-document-runtime-not-ready/u);
  assert.match(context, /not persisted/);
});

test('SessionStart retains local configuration behavior for an ordinary remote', async () => {
  const root = path.join(artifactsRoot, `${Date.now()}-${process.pid}-${fixtureSequence += 1}-session-start-ordinary`);
  const fakeHome = path.join(root, 'fake-home');
  await mkdir(root, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await run('git', ['init', '--quiet'], { cwd: root });
  await run('git', ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'], { cwd: root });
  await writeFile(path.join(root, '.horspowers-config.yaml'), teamConfig(), 'utf8');

  const result = await runHook('session-start.sh', { cwd: root, env: { HOME: fakeHome } });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /<config-valid>true<\/config-valid>/);
  assert.doesNotMatch(context, /external-document-runtime-not-ready/);
});
