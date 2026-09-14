import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive finite number');
  return Math.ceil(timeoutMs);
}

function terminate(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') child.kill(signal);
  }
}

export function runWithTimeout({ timeoutMs, command, args = [], cwd, env, stdin = null } = {}) {
  const timeout = parseTimeout(timeoutMs);
  if (typeof command !== 'string' || command.length === 0) throw new TypeError('command must be a non-empty string');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('args must be strings');

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    if (stdin && typeof stdin.pipe === 'function') stdin.pipe(child.stdin);
    else child.stdin.end();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let forceKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => terminate(child, 'SIGKILL'), 250);
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ exitCode: timedOut ? 124 : (exitCode ?? 128), signal: timedOut ? 'SIGTERM' : signal, timedOut, stdout, stderr });
    });
  });
}

function parseCli(argv) {
  const [duration, separator, command, ...args] = argv;
  if (!duration || separator !== '--' || !command) throw new Error('Usage: portable-timeout <seconds|duration> -- <command> [args...]');
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(duration);
  if (!match) throw new Error('duration must be a positive number with optional ms, s, or m suffix');
  const factor = { ms: 1, s: 1000, m: 60_000, undefined: 1000 }[match[2]?.toLowerCase()];
  return { timeoutMs: Number(match[1]) * factor, command, args };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = await runWithTimeout({ ...parseCli(process.argv.slice(2)), stdin: process.stdin });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.code === 'ENOENT' ? 127 : 2;
  }
}
