#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderMcpRegistration, SUPPORTED_HOSTS } from '../lib/hps-mcp-registration.mjs';

function usage() {
  return 'Usage: node scripts/install-hps-mcp.mjs --host <claude|codex|opencode> --installation-root <absolute-root> [--output <file>]';
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--host', '--installation-root', '--output'].includes(key)) throw new Error(usage());
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(usage());
    result[key.slice(2).replaceAll('-', '_')] = value;
  }
  if (!SUPPORTED_HOSTS.includes(result.host) || !result.installation_root) throw new Error(usage());
  return result;
}

async function assertNativeInstallationRoot(root) {
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('installation root must be an existing native plugin directory');
  }
  const entry = path.join(root, 'bin', 'hps');
  const entryStat = await fs.lstat(entry).catch(() => null);
  if (!entryStat?.isFile() || entryStat.isSymbolicLink() || (process.platform !== 'win32' && (entryStat.mode & 0o111) === 0)) {
    throw new Error('installation root must contain the native executable bin/hps');
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  await assertNativeInstallationRoot(path.resolve(args.installation_root));
  const registration = renderMcpRegistration(args.host, args.installation_root);
  const text = `${JSON.stringify(registration, null, 2)}\n`;
  if (args.output) {
    const output = path.resolve(args.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, text, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`${output}\n`);
  } else {
    process.stdout.write(text);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
