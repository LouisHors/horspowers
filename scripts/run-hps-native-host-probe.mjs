#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNativeHostProbe, SUPPORTED_PROBE_HOSTS } from '../lib/hps-native-host-probe.mjs';

function usage() {
  return 'Usage: node scripts/run-hps-native-host-probe.mjs --host <codex|claude> --installation-root <absolute-root> [--cwd <absolute-project>] [--timeout-ms <positive-ms>]';
}

function parseArgs(argv) {
  const result = { cwd: process.cwd(), timeoutMs: 30_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--host', '--installation-root', '--cwd', '--timeout-ms'].includes(key)) throw new Error(usage());
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(usage());
    if (key === '--timeout-ms') {
      if (!/^\d+(?:\.\d+)?$/u.test(value) || Number(value) <= 0) throw new Error(usage());
      result.timeoutMs = Number(value);
    } else {
      result[key.slice(2).replaceAll('-', '_')] = value;
    }
  }
  if (!SUPPORTED_PROBE_HOSTS.includes(result.host) || typeof result.installation_root !== 'string') throw new Error(usage());
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const report = await runNativeHostProbe({
    host: args.host,
    installationRoot: path.resolve(args.installation_root),
    cwd: path.resolve(args.cwd),
    timeoutMs: args.timeoutMs
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === 'pass' ? 0 : (report.status === 'blocked_prerequisite' ? 2 : 1);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, status: 'failed', error_code: error.code ?? 'probe_failed', error: error.message })}\n`);
  process.exitCode = error.code === 'ENOENT' ? 127 : 1;
}

export { parseArgs };
