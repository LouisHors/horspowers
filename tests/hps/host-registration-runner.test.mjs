import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';

import { renderMcpRegistration, SUPPORTED_HOSTS } from '../../lib/hps-mcp-registration.mjs';
import { runWithTimeout } from '../../lib/portable-timeout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);

test('MCP registration renders native installation root for all supported hosts', () => {
  assert.deepEqual(SUPPORTED_HOSTS, ['claude', 'codex', 'opencode']);
  const installRoot = '/native/plugin/horspowers';

  const claude = renderMcpRegistration('claude', installRoot);
  assert.equal(claude.mcpServers.hps.command, `${installRoot}/bin/hps`);
  assert.deepEqual(claude.mcpServers.hps.args, ['serve', '--stdio']);

  const codex = renderMcpRegistration('codex', installRoot);
  assert.equal(codex.mcp_servers.hps.command, `${installRoot}/bin/hps`);
  assert.deepEqual(codex.mcp_servers.hps.args, ['serve', '--stdio']);

  const opencode = renderMcpRegistration('opencode', installRoot);
  assert.deepEqual(opencode.mcp.hps.command, [`${installRoot}/bin/hps`, 'serve', '--stdio']);
});

test('registration rejects guessed or non-absolute installation roots', () => {
  for (const root of ['', 'horspowers', '../horspowers', '~/.codex/horspowers', '/tmp/foo/../etc', '/tmp/./horspowers']) {
    assert.throws(() => renderMcpRegistration('claude', root), /installation root/i);
  }
});

test('registration CLI requires the discovered root to contain the native hps entrypoint', async () => {
  const script = path.join(ROOT, 'scripts', 'install-hps-mcp.mjs');
  const valid = await execFileAsync(process.execPath, [script, '--host', 'codex', '--installation-root', ROOT]);
  const parsed = JSON.parse(valid.stdout);
  assert.equal(parsed.mcp_servers.hps.command, path.join(ROOT, 'bin', 'hps'));

  await assert.rejects(
    execFileAsync(process.execPath, [script, '--host', 'codex', '--installation-root', '/tmp']),
    (error) => error.code === 2 && /native plugin directory|native executable bin\/hps/u.test(error.stderr)
  );
});

test('registration templates are present and never edit user configuration', async () => {
  for (const host of SUPPORTED_HOSTS) {
    const templateName = host === 'claude' ? 'claude.mcp.json' : `${host}.json`;
    const template = path.join(ROOT, 'templates', 'mcp', templateName);
    const source = await fs.readFile(template, 'utf8');
    assert.match(source, /__HPS_INSTALL_ROOT__\/bin\/hps/);
    assert.match(source, /serve/);
    assert.match(source, /stdio/);
  }
});

test('portable timeout preserves stdout/stderr and returns 124 on timeout', async () => {
  const fixture = path.join(ROOT, 'tests', 'hps', 'fixtures', 'timeout-runner-fixture.mjs');
  const success = await runWithTimeout({ timeoutMs: 1000, command: process.execPath, args: [fixture, 'echo'] });
  assert.equal(success.timedOut, false);
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout, 'fixture stdout\n');
  assert.equal(success.stderr, 'fixture stderr\n');

  const timed = await runWithTimeout({ timeoutMs: 200, command: process.execPath, args: [fixture, 'sleep'] });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.exitCode, 124);
  assert.match(timed.stdout, /before timeout/);
  assert.match(timed.stderr, /before timeout/);
});

test('portable timeout validates command and timeout inputs', () => {
  assert.throws(() => runWithTimeout({ timeoutMs: 0, command: process.execPath }), /timeoutMs/i);
  assert.throws(() => runWithTimeout({ timeoutMs: 100, command: '' }), /command/i);
});

test('portable timeout forwards piped stdin for agent CLI calls', async () => {
  const fixture = path.join(ROOT, 'tests', 'hps', 'fixtures', 'timeout-runner-fixture.mjs');
  const stdin = new PassThrough();
  const pending = runWithTimeout({ timeoutMs: 1000, command: process.execPath, args: [fixture, 'stdin'], stdin });
  stdin.end('hps-request\n');
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'hps-request\n');
});
