import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = path.join(repoRoot, 'skills/using-horspowers/scripts/route-request.mjs');
const shellMarker = '/private/tmp/horspowers-route-request-shell-marker';
const artifactsRoot = path.join(repoRoot, 'tests/.artifacts/workflow-router');
const run = promisify(execFile);
let fixtureRoot;
let companyFixtureRoot;
let fakeHome;

before(async () => {
  const runId = `${Date.now()}-${process.pid}-cli`;
  fixtureRoot = path.join(artifactsRoot, runId, 'project');
  fakeHome = path.join(artifactsRoot, runId, 'home');
  await mkdir(fixtureRoot, { recursive: true });
  companyFixtureRoot = path.join(artifactsRoot, runId, 'company-project');
  await mkdir(companyFixtureRoot, { recursive: true });
  await mkdir(fakeHome, { recursive: true });
  await run('git', ['init', '--quiet'], { cwd: fixtureRoot });
  await run('git', ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'], { cwd: fixtureRoot });
  await run('git', ['init', '--quiet'], { cwd: companyFixtureRoot });
  await run('git', ['remote', 'add', 'origin', 'git@gitlab.ugnas.com:platform/ugcli-lib.git'], { cwd: companyFixtureRoot });
});

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

function validInput(overrides = {}) {
  return {
    schema_version: 1,
    host: 'codex',
    cwd: fixtureRoot,
    message: '把这段文字翻译成英文',
    active_route: null,
    ...overrides
  };
}

async function runCli({ input = '', args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: fakeHome, ...env },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const [exitCode] = await once(child, 'close');
  return { exitCode, stdout, stderr };
}

test('writes exactly one JSON object for a valid stdin envelope', async () => {
  const result = await runCli({ input: JSON.stringify(validInput()) });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^\{.*\}\n$/s);
  assert.equal(JSON.parse(result.stdout).routing.route, 'direct');
});

test('does not load an old document workflow for a company project before the runtime exists', async () => {
  const before = await snapshotTree(companyFixtureRoot);
  const result = await runCli({
    input: JSON.stringify(validInput({
      cwd: companyFixtureRoot,
      message: '给这个功能写实施计划'
    }))
  });
  const after = await snapshotTree(companyFixtureRoot);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(after, before);
  const output = JSON.parse(result.stdout);
  assert.equal(output.routing.route, 'planning');
  assert.equal(output.routing.target_skill, null);
  assert.equal(output.routing.blocked_by, 'company_external_config_required');
  assert.equal(output.project.eligibility, 'external_project');
});

test('does not execute shell syntax embedded in a user message', async () => {
  assert.equal(existsSync(shellMarker), false, 'shell marker must not pre-exist');
  const result = await runCli({
    input: JSON.stringify(validInput({ message: `翻译这段: $(touch ${shellMarker}) \`touch ${shellMarker}\`` }))
  });

  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(shellMarker), false);
});

test('rejects user content supplied as argv', async () => {
  const result = await runCli({ args: ['把这段文字翻译成英文'] });

  assert.equal(result.exitCode, 64);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /stdin only/i);
});

test('rejects oversized and malformed input contracts without stdout', async () => {
  const inputs = [
    JSON.stringify(validInput({ message: 'a'.repeat(4097) })),
    JSON.stringify(validInput({ host: 'unknown-host' })),
    JSON.stringify(validInput({ cwd: 'relative/path' })),
    JSON.stringify(validInput({ unexpected: true })),
    '{not json'
  ];

  for (const input of inputs) {
    const result = await runCli({ input });
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.stdout, '');
  }
});

test('degrades invalid rules to an uncertain response without mutations', async () => {
  const result = await runCli({
    input: JSON.stringify(validInput()),
    env: { HORSPOWERS_ROUTE_RULES_PATH: '/private/tmp/horspowers-missing-route-rules.json' }
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.routing.route, 'uncertain');
  assert.equal(output.routing.target_skill, null);
  assert.equal(output.routing.routing_error, 'RULES_INVALID');
  assert.deepEqual(output.mutations, []);
});
