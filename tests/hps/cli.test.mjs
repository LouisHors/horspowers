import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';

function run(args, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['bin/hps', ...args], { cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input);
  });
}

test('hps version --json emits one JSON object', async () => {
  const result = await run(['version', '--json']);
  assert.equal(result.code, 0);
  const value = JSON.parse(result.out);
  assert.equal(value.command, 'hps');
});

test('installed bin/hps entrypoint executes directly from the installation root', async () => {
  const child = spawn(path.resolve('bin/hps'), ['version', '--json'], {
    cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], shell: false
  });
  let stdout = '';
  for await (const chunk of child.stdout) stdout += chunk;
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).command, 'hps');
});

test('hps call reads JSON until EOF and emits one envelope', async () => {
  const result = await run(['call'], JSON.stringify({
    schema_version: 1, request_id: 'r1', operation: 'runtime_doctor', cwd: path.resolve('.'), input: {}
  }));
  assert.equal(result.code, 0);
  const value = JSON.parse(result.out);
  assert.equal(value.status, 'ok');
  assert.equal(value.request_id, 'r1');
  assert.equal(result.out.trim().split('\n').length, 1);
  const progress = result.err.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(progress.map((event) => event.status), ['started', 'completed']);
  assert.ok(progress.every((event) => event.phase === 'runtime_doctor'));
  assert.doesNotMatch(result.err, /design this|secret|token/iu);
});

test('hps call rejects argv payload and invalid operation as JSON', async () => {
  const argvResult = await run(['call', 'payload']);
  assert.equal(JSON.parse(argvResult.out).error.code, 'argv_not_supported');
  const bad = await run(['call'], JSON.stringify({ schema_version: 1, request_id: 'r1', operation: 'shell', cwd: '/repo', input: {} }));
  assert.equal(JSON.parse(bad.out).error.code, 'operation_not_found');
  assert.doesNotMatch(bad.out, /shell/iu);
});

test('hps call returns operation_unavailable before validating deferred input fields', async () => {
  const result = await run(['call'], JSON.stringify({
    schema_version: 1, request_id: 'deferred-cli', operation: 'document_change_submit', cwd: '/repo',
    input: { arbitrary: 'payload', token: 'never-echo' }
  }));
  assert.equal(JSON.parse(result.out).error.code, 'operation_unavailable');
  assert.doesNotMatch(result.out, /never-echo/iu);
});

test('hps call maps malformed JSON to invalid_request without echoing parser input', async () => {
  const result = await run(['call'], '{"token":"never-echo"');
  const envelope = JSON.parse(result.out);
  assert.equal(envelope.error.code, 'invalid_request');
  assert.equal(envelope.error.message, 'invalid_request');
  assert.doesNotMatch(result.out, /never-echo/iu);
});
