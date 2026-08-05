import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scriptPath = path.join(repoRoot, 'skills/using-horspowers/scripts/route-request.mjs');
const shellMarker = '/private/tmp/horspowers-route-request-shell-marker';

function validInput(overrides = {}) {
  return {
    schema_version: 1,
    host: 'codex',
    cwd: repoRoot,
    message: '把这段文字翻译成英文',
    active_route: null,
    ...overrides
  };
}

async function runCli({ input = '', args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
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
