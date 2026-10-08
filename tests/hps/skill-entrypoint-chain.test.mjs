import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { HPS_OPERATION_DEFINITIONS, exposedHpsTools } from '../../lib/hps-operations.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hpsBin = path.join(repoRoot, 'bin', 'hps');
const documentCli = path.join(repoRoot, 'lib', 'document-runtime-cli.mjs');
const execFileAsync = promisify(execFile);

const runId = `${Date.now()}-${process.pid}-chain`;
const artifactsRoot = path.join(repoRoot, 'tests/.artifacts/hps-entrypoint-chain');
const fixtureRoot = path.join(artifactsRoot, runId, 'project');

const DOCUMENT_READS = ['document_resolve', 'document_search', 'document_get', 'document_manifest', 'document_verify'];
const PHASE5_DOCUMENT_WRITES = [
  'document_change_preview',
  'document_change_submit',
  'document_transition_preview',
  'document_transition_submit',
  'project_bootstrap_preview',
  'project_bootstrap_submit'
];

after(async () => {
  await rm(path.join(artifactsRoot, runId), { recursive: true, force: true });
});

function spawnNode(script, { args = [], input = '', cwd = repoRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function hpsCall(request) {
  return spawnNode(hpsBin, { args: ['call'], input: `${JSON.stringify(request)}\n` });
}

async function createFixtureRepository() {
  await mkdir(fixtureRoot, { recursive: true });
  await execFileAsync('git', ['init', '--quiet'], { cwd: fixtureRoot });
  await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'], { cwd: fixtureRoot });
  await writeFile(path.join(fixtureRoot, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: fixtureRoot });
  await execFileAsync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'init'], { cwd: fixtureRoot });
}

test('HPS registers document reads but leaves Phase 5 document writes unexposed', () => {
  const tools = exposedHpsTools();
  const names = new Set(tools.map(({ name }) => name));

  for (const read of DOCUMENT_READS) assert.ok(names.has(read), `missing exposed read tool: ${read}`);

  for (const write of PHASE5_DOCUMENT_WRITES) {
    assert.equal(names.has(write), false, `phase 5 write must not be exposed: ${write}`);
    assert.equal(HPS_OPERATION_DEFINITIONS[write].exposed, false, write);
    assert.equal(HPS_OPERATION_DEFINITIONS[write].deferred, true, write);
  }
});

test('default read chain enters the shared core through hps call', async () => {
  await createFixtureRepository();

  const prepare = await hpsCall({
    schema_version: 1,
    request_id: 'chain-prepare',
    operation: 'task_prepare',
    cwd: fixtureRoot,
    input: { message: '解释一下这个模块', host: 'codex' }
  });
  assert.equal(prepare.code, 0, prepare.stderr);
  const prepared = JSON.parse(prepare.stdout);
  assert.equal(prepared.status, 'ok');
  assert.equal(typeof prepared.result.routing?.route, 'string');
  assert.ok(prepared.result.project);
  assert.equal(typeof prepared.result.scope?.scope_id, 'string');

  const resolve = await hpsCall({
    schema_version: 1,
    request_id: 'chain-resolve',
    operation: 'document_resolve',
    cwd: fixtureRoot,
    input: {}
  });
  assert.equal(resolve.code, 0, resolve.stderr);
  const resolved = JSON.parse(resolve.stdout);
  assert.equal(resolved.status, 'ok');
  assert.equal(typeof resolved.result.status, 'string');
  assert.ok(['disabled', 'local', 'wiki'].includes(resolved.result.backend), resolved.result.backend);
});

test('Phase 5 document writes stay out of the HPS entrypoint', async () => {
  for (const operation of PHASE5_DOCUMENT_WRITES.filter((name) => name.endsWith('_submit'))) {
    const response = await hpsCall({
      schema_version: 1,
      request_id: `chain-${operation}`,
      operation,
      cwd: repoRoot,
      input: {}
    });
    assert.equal(response.code, 0, response.stderr);
    const envelope = JSON.parse(response.stdout);
    assert.equal(envelope.status, 'error', operation);
    assert.equal(envelope.error.code, 'operation_unavailable', operation);
  }
});

test('document writes keep the controlled DocumentRuntime compatibility protocol', async () => {
  const response = await spawnNode(documentCli, {
    input: `${JSON.stringify({ schema_version: 1, cwd: repoRoot, action: 'resolve', request: {}, confirmed: false })}\n`
  });
  assert.equal(response.code, 0, response.stderr);

  const lines = response.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `stdout must be one JSON object: ${response.stdout}`);
  const payload = JSON.parse(lines[0]);
  assert.equal(typeof payload.status, 'string');
  assert.ok(['disabled', 'local', 'wiki'].includes(payload.backend), payload.backend);
});

test('document-management skill routes reads to HPS and writes to the compatibility writer', async () => {
  const skill = await readFile(path.join(repoRoot, 'skills/document-management/SKILL.md'), 'utf8');

  assert.match(skill, /HPS 目前只公开 document \*\*只读\*\*工具/u);
  assert.match(skill, /`operation_unavailable`/u);
  assert.match(skill, /`document-runtime-cli\.mjs` 受控兼容写入入口/u);
  assert.match(skill, /`resolve` \/ `get` \/ `search` \/ `manifest` \/ `verify`[\s\S]*?HPS/u);
  assert.match(skill, /`create` \/ `update` \/ `archive` \/ `restore` \/ `config-change` \/ `record-session`[\s\S]*?document-runtime-cli\.mjs/u);
});
