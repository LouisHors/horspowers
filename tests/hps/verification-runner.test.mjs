import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HpsRuntime } from '../../lib/hps-runtime.mjs';
import { createVerificationRunner } from '../../lib/hps-verification.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'tests/hps/fixtures/verification-runner-fixture.mjs');

function profiles() {
  return Object.freeze({
    pass: Object.freeze({ id: 'pass', program: process.execPath, args: Object.freeze([fixture, 'pass']), timeout_ms: 1_000, network: false }),
    fail: Object.freeze({ id: 'fail', program: process.execPath, args: Object.freeze([fixture, 'fail']), timeout_ms: 1_000, network: false }),
    output: Object.freeze({ id: 'output', program: process.execPath, args: Object.freeze([fixture, 'output']), timeout_ms: 1_000, network: false }),
    timeout: Object.freeze({ id: 'timeout', program: process.execPath, args: Object.freeze([fixture, 'wait']), timeout_ms: 30, network: false }),
    abort: Object.freeze({ id: 'abort', program: process.execPath, args: Object.freeze([fixture, 'wait']), timeout_ms: 5_000, network: false }),
    network: Object.freeze({ id: 'network', program: process.execPath, args: Object.freeze([fixture, 'pass']), timeout_ms: 1_000, network: true })
  });
}

test('default runtime executes the installed hps-unit profile without an injected runner', async () => {
  const runtime = new HpsRuntime({ capabilities: { local_process: true, external_network: false } });
  const scope_id = runtime.openScope({ root: repoRoot });
  const result = await runtime.verificationRun({ cwd: repoRoot, scope_id, profile: 'hps-unit' });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /pass|test/iu);
});

test('real runner returns bounded failed evidence and redacts credentials', async () => {
  const run = createVerificationRunner({ profiles: profiles() });
  const failed = await run({ profile: 'fail', cwd: repoRoot, capabilities: { local_process: true, external_network: false } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exit_code, 2);
  assert.match(failed.stderr, /\[redacted\]/u);
  assert.doesNotMatch(failed.stderr, /synthetic-secret/u);

  const output = await run({ profile: 'output', cwd: repoRoot, capabilities: { local_process: true, external_network: false } });
  assert.equal(output.truncated, true);
  assert.ok(Buffer.byteLength(output.stdout) <= 16_384);
  assert.ok(Buffer.byteLength(output.stderr) <= 4_096);
});

test('real runner enforces timeout, abort, process, and network capability gates', async () => {
  const run = createVerificationRunner({ profiles: profiles() });
  const timedOut = await run({ profile: 'timeout', cwd: repoRoot, capabilities: { local_process: true, external_network: false } });
  assert.equal(timedOut.status, 'timeout');
  assert.equal(timedOut.error_code, 'verification_timeout');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const aborted = await run({ profile: 'abort', cwd: repoRoot, capabilities: { local_process: true, external_network: false }, signal: controller.signal });
  assert.equal(aborted.status, 'cancelled');
  assert.equal(aborted.error_code, 'verification_cancelled');

  const noProcess = await run({ profile: 'pass', cwd: repoRoot, capabilities: { local_process: false, external_network: false } });
  assert.equal(noProcess.error_code, 'local_process_required');
  const noNetwork = await run({ profile: 'network', cwd: repoRoot, capabilities: { local_process: true, external_network: false } });
  assert.equal(noNetwork.error_code, 'network_required');
});

test('runner rejects a non-canonical cwd and request-side execution overrides', async () => {
  const run = createVerificationRunner({ profiles: profiles() });
  const invalid = await run({ profile: 'pass', cwd: 'relative', capabilities: { local_process: true } });
  assert.equal(invalid.error_code, 'verification_cwd_invalid');
  const runtime = new HpsRuntime({ capabilities: { local_process: true } });
  const scope_id = runtime.openScope({ root: repoRoot });
  for (const override of [
    { command: 'node' }, { argv: ['--test'] }, { env: { TOKEN: 'x' } }, { path: fixture }
  ]) {
    await assert.rejects(
      () => runtime.verificationRun({ cwd: repoRoot, scope_id, profile: 'hps-unit', ...override }),
      /command|argv|env|path|override/iu
    );
  }
});

test('runner preserves the Electron run-as-node marker without widening the child environment', async () => {
  let seenEnvironment = null;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const run = createVerificationRunner({
    profiles: profiles(),
    environment: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', SECRET_TOKEN: 'must-not-leak' },
    spawnImpl: (_program, _args, options) => {
      seenEnvironment = options.env;
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from('ok\n'));
        child.emit('close', 0);
      });
      return child;
    }
  });

  const result = await run({ profile: 'pass', cwd: repoRoot, capabilities: { local_process: true, external_network: false } });

  assert.equal(result.status, 'passed');
  assert.equal(seenEnvironment.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(seenEnvironment.PATH, '/usr/bin');
  assert.equal(Object.hasOwn(seenEnvironment, 'SECRET_TOKEN'), false);
});
