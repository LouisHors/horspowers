import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_STDOUT_BYTES = 16_384;
const MAX_STDERR_BYTES = 4_096;
const SAFE_ENV_KEYS = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'WINDIR'];

function profile(id, args, { timeoutMs = 30_000, network = false } = {}) {
  return Object.freeze({
    id,
    program: process.execPath,
    args: Object.freeze(args),
    timeout_ms: timeoutMs,
    network
  });
}

export const VERIFICATION_PROFILES = Object.freeze({
  'hps-unit': profile('hps-unit', [
    '--test',
    path.join(installRoot, 'tests/hps/protocol.test.mjs'),
    path.join(installRoot, 'tests/hps/runtime.test.mjs')
  ]),
  'hps-regression': profile('hps-regression', [
    '--test',
    path.join(installRoot, 'tests/context-collector/collector.test.mjs'),
    path.join(installRoot, 'tests/workflow-router/classifier.test.mjs'),
    path.join(installRoot, 'tests/workflow-router/route-rules.test.mjs')
  ]),
  'context-collector': profile('context-collector', [
    '--test',
    path.join(installRoot, 'tests/context-collector/collector.test.mjs')
  ])
});

// `process.execPath` can point at an Electron binary when Horspowers runs
// under an Electron-based Node harness. A child only executes its script as
// Node when it inherits the run-as-node marker, so keep that single flag while
// every other variable stays allowlisted.
function electronRunAsNodeMarker(source) {
  if (source.ELECTRON_RUN_AS_NODE === '1') return '1';
  return process.versions.electron ? '1' : null;
}

function safeEnvironment(source = process.env) {
  const environment = Object.fromEntries(SAFE_ENV_KEYS.flatMap((key) =>
    typeof source[key] === 'string' ? [[key, source[key]]] : []
  ));
  const marker = electronRunAsNodeMarker(source);
  if (marker) environment.ELECTRON_RUN_AS_NODE = marker;
  return environment;
}

function redact(value) {
  return String(value ?? '')
    .replace(/\b(token|password|secret|credential|authorization)=\S+/giu, '$1=[redacted]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]');
}

function unavailable(errorCode) {
  return {
    status: 'unavailable',
    error_code: errorCode,
    exit_code: null,
    stdout: '',
    stderr: '',
    truncated: false,
    duration_ms: 0
  };
}

function appendBounded(state, chunk, limit) {
  const buffer = Buffer.from(chunk);
  state.seen += buffer.length;
  if (state.value.length >= limit) return;
  state.value = Buffer.concat([state.value, buffer.subarray(0, limit - state.value.length)]);
}

function validProfileRegistry(profiles) {
  return profiles && typeof profiles === 'object' && !Array.isArray(profiles) &&
    Object.entries(profiles).every(([id, value]) => value?.id === id && path.isAbsolute(value.program) &&
      Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string') &&
      Number.isSafeInteger(value.timeout_ms) && value.timeout_ms > 0 && value.timeout_ms <= 120_000 &&
      typeof value.network === 'boolean');
}

export function createVerificationRunner({ profiles = VERIFICATION_PROFILES, spawnImpl = spawn, environment = process.env } = {}) {
  if (!validProfileRegistry(profiles)) throw new TypeError('verification profile registry is invalid');
  const registry = profiles;

  return async function runVerification({ profile: profileId, cwd, capabilities = {}, signal } = {}) {
    const selected = registry[profileId];
    if (!selected) return unavailable('profile_not_allowlisted');
    if (capabilities.local_process !== true) return unavailable('local_process_required');
    if (selected.network && capabilities.external_network !== true) return unavailable('network_required');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || path.normalize(cwd) !== cwd) {
      return unavailable('verification_cwd_invalid');
    }
    let canonicalCwd;
    try {
      canonicalCwd = await realpath(cwd);
    } catch {
      return unavailable('verification_cwd_invalid');
    }
    if (signal?.aborted) return { ...unavailable('verification_cancelled'), status: 'cancelled' };

    const started = performance.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(selected.program, [...selected.args], {
          cwd: canonicalCwd,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: safeEnvironment(environment)
        });
      } catch {
        resolve({ ...unavailable('verification_spawn_failed'), duration_ms: Math.round(performance.now() - started) });
        return;
      }

      const stdout = { value: Buffer.alloc(0), seen: 0 };
      const stderr = { value: Buffer.alloc(0), seen: 0 };
      let reason = null;
      let settled = false;
      let killTimer = null;
      const terminate = (nextReason) => {
        if (reason) return;
        reason = nextReason;
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 100);
        killTimer.unref?.();
      };
      const timeout = setTimeout(() => terminate('timeout'), selected.timeout_ms);
      const abort = () => terminate('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', (chunk) => appendBounded(stdout, chunk, MAX_STDOUT_BYTES));
      child.stderr?.on('data', (chunk) => appendBounded(stderr, chunk, MAX_STDERR_BYTES));

      const finish = (code, spawnError = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        const timedOut = reason === 'timeout';
        const cancelled = reason === 'cancelled';
        resolve({
          profile: selected.id,
          status: timedOut ? 'timeout' : cancelled ? 'cancelled' : spawnError ? 'unavailable' : code === 0 ? 'passed' : 'failed',
          error_code: timedOut ? 'verification_timeout' : cancelled ? 'verification_cancelled' : spawnError ? 'verification_spawn_failed' : code === 0 ? null : 'verification_failed',
          exit_code: Number.isInteger(code) ? code : null,
          stdout: redact(stdout.value.toString('utf8')),
          stderr: redact(stderr.value.toString('utf8')),
          truncated: stdout.seen > MAX_STDOUT_BYTES || stderr.seen > MAX_STDERR_BYTES,
          duration_ms: Math.max(0, Math.round(performance.now() - started))
        });
      };
      child.once('error', () => finish(null, true));
      child.once('close', (code) => finish(code));
    });
  };
}

export const runVerificationProfile = createVerificationRunner();
