import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyAgentsBlock, planAgentsBlock } from '../../lib/agents-managed-block.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const templatePath = path.join(repoRoot, 'skills/using-horspowers/templates/codex-agents-managed-block.md');
const artifactsRoot = path.join(repoRoot, 'tests/.artifacts/workflow-router');
let fixtureSequence = 0;

async function fakeHome(name) {
  const root = path.join(
    artifactsRoot,
    `${Date.now()}-${process.pid}-${fixtureSequence += 1}-${name}`
  );
  await mkdir(root, { recursive: true });
  return root;
}

function agentsPath(homeDir) {
  return path.join(homeDir, '.codex', 'AGENTS.md');
}

test('creates the managed block in an absent Codex AGENTS file', async () => {
  const homeDir = await fakeHome('agents-create');
  const plan = await planAgentsBlock({ host: 'codex', homeDir, templatePath });
  const result = await applyAgentsBlock(plan);

  assert.equal(plan.status, 'create');
  assert.equal(result.status, 'created');
  const content = await readFile(agentsPath(homeDir), 'utf8');
  assert.match(content, /horspowers:managed-routing:start version=1/);
  assert.match(content, /horspowers:managed-routing:end/);
});

test('appends without changing user content and is idempotent', async () => {
  const homeDir = await fakeHome('agents-append');
  const agentsFile = agentsPath(homeDir);
  const userContent = '# Personal rules\n\nDo not change this paragraph.\n';
  await mkdir(path.dirname(agentsFile), { recursive: true });
  await writeFile(agentsFile, userContent, 'utf8');

  const first = await applyAgentsBlock(await planAgentsBlock({ host: 'codex', homeDir, templatePath }));
  const afterFirst = await readFile(agentsFile, 'utf8');
  const secondPlan = await planAgentsBlock({ host: 'codex', homeDir, templatePath });
  const second = await applyAgentsBlock(secondPlan);
  const afterSecond = await readFile(agentsFile, 'utf8');

  assert.equal(first.status, 'created');
  assert.ok(afterFirst.startsWith(userContent));
  assert.equal(secondPlan.status, 'unchanged');
  assert.equal(second.status, 'unchanged');
  assert.equal(afterSecond, afterFirst);
  assert.equal((afterSecond.match(/horspowers:managed-routing:start/g) ?? []).length, 1);
});

test('backs up and replaces only an outdated managed block', async () => {
  const homeDir = await fakeHome('agents-update');
  const agentsFile = agentsPath(homeDir);
  const original = [
    '# Keep this prefix',
    '<!-- horspowers:managed-routing:start version=0 -->',
    'outdated routing text',
    '<!-- horspowers:managed-routing:end -->',
    '# Keep this suffix',
    ''
  ].join('\n');
  await mkdir(path.dirname(agentsFile), { recursive: true });
  await writeFile(agentsFile, original, 'utf8');

  const plan = await planAgentsBlock({ host: 'codex', homeDir, templatePath });
  const result = await applyAgentsBlock(plan);
  const updated = await readFile(agentsFile, 'utf8');

  assert.equal(plan.status, 'update');
  assert.equal(result.status, 'updated');
  assert.ok(result.backup_path);
  assert.equal(await readFile(result.backup_path, 'utf8'), original);
  assert.match(updated, /^# Keep this prefix/m);
  assert.match(updated, /^# Keep this suffix/m);
  assert.match(updated, /start version=1/);
  assert.doesNotMatch(updated, /outdated routing text/);
});

test('refuses malformed managed markers without changing the user file', async () => {
  const malformedContents = [
    [
      '<!-- horspowers:managed-routing:start version=1 -->',
      '<!-- horspowers:managed-routing:end -->',
      '<!-- horspowers:managed-routing:start version=1 -->',
      '<!-- horspowers:managed-routing:end -->'
    ].join('\n'),
    '<!-- horspowers:managed-routing:start version=1 -->\nmissing end marker\n',
    [
      '<!-- horspowers:managed-routing:start version=1 -->',
      '<!-- horspowers:managed-routing:start version=1 -->',
      '<!-- horspowers:managed-routing:end -->',
      '<!-- horspowers:managed-routing:end -->'
    ].join('\n')
  ];

  for (const [index, content] of malformedContents.entries()) {
    const homeDir = await fakeHome(`agents-malformed-${index}`);
    const agentsFile = agentsPath(homeDir);
    await mkdir(path.dirname(agentsFile), { recursive: true });
    await writeFile(agentsFile, content, 'utf8');
    const before = await readFile(agentsFile);

    const plan = await planAgentsBlock({ host: 'codex', homeDir, templatePath });
    const result = await applyAgentsBlock(plan);

    assert.equal(plan.status, 'failed');
    assert.equal(result.status, 'failed');
    assert.deepEqual(await readFile(agentsFile), before);
  }
});

test('skips all non-Codex hosts without creating global files', async () => {
  for (const host of ['claude', 'other']) {
    const homeDir = await fakeHome(`agents-${host}`);
    const plan = await planAgentsBlock({ host, homeDir, templatePath });
    const result = await applyAgentsBlock(plan);

    assert.equal(plan.status, 'skipped');
    assert.equal(result.status, 'skipped');
    assert.equal(existsSync(path.join(homeDir, '.codex')), false);
  }
});
