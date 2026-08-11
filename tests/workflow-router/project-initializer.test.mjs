import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeConfigIfMissing } from '../../lib/config-manager.js';
import {
  applyProjectInitialization,
  planProjectInitialization
} from '../../lib/project-initializer.mjs';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactsRoot = path.join(repoRoot, 'tests/.artifacts/workflow-router');
let fixtureSequence = 0;

async function retainedFixture(name) {
  const root = path.join(
    artifactsRoot,
    `${Date.now()}-${process.pid}-${fixtureSequence += 1}-${name}`
  );
  await mkdir(root, { recursive: true });
  return root;
}

async function gitFixture(name, { remoteUrl = 'https://github.com/example/fixture.git' } = {}) {
  const root = await retainedFixture(name);
  await run('git', ['init', '--quiet'], { cwd: root });
  if (remoteUrl) await run('git', ['remote', 'add', 'origin', remoteUrl], { cwd: root });
  return root;
}

async function snapshotTree(root) {
  const entries = [];

  async function walk(current, relative = '') {
    const details = await lstat(current);
    if (details.isFile()) {
      entries.push({
        path: relative,
        type: 'file',
        sha256: createHash('sha256').update(await readFile(current)).digest('hex')
      });
      return;
    }
    if (details.isSymbolicLink()) {
      entries.push({ path: relative, type: 'symlink' });
      return;
    }
    entries.push({ path: relative, type: 'directory' });
    for (const name of await readdir(current)) {
      await walk(path.join(current, name), path.join(relative, name));
    }
  }

  await walk(root);
  return entries;
}

function teamConfig({ documentationEnabled = true, version = '4.5.0' } = {}) {
  return `version: ${version}\ndevelopment_mode: team\nbranch_strategy: worktree\ntesting_strategy: tdd\ncompletion_strategy: pr\ndocumentation:\n  enabled: ${documentationEnabled}\n`;
}

test('keeps retained workflow-router fixtures ignored', async () => {
  const { stdout } = await run('git', ['check-ignore', 'tests/.artifacts/workflow-router/probe'], { cwd: repoRoot });
  assert.match(stdout, /tests\/\.artifacts/);
});

test('plans initialization for a normal Git root and its nested directory', async () => {
  const root = await gitFixture('git-root');
  const nested = path.join(root, 'nested/child');
  await mkdir(nested, { recursive: true });

  const rootPlan = await planProjectInitialization({ cwd: root, homeDir: homedir(), tempDir: tmpdir() });
  const nestedPlan = await planProjectInitialization({ cwd: nested, homeDir: homedir(), tempDir: tmpdir() });

  assert.equal(rootPlan.eligibility, 'project');
  assert.equal(rootPlan.project_root, root);
  assert.equal(rootPlan.config_action, 'create');
  assert.equal(rootPlan.docs_action, 'create');
  assert.equal(nestedPlan.eligibility, 'project');
  assert.equal(nestedPlan.project_root, root);
});

test('uses an explicit marker only after confirming an ordinary Git remote', async () => {
  const marked = await gitFixture('marked-project');
  await writeFile(path.join(marked, '.horspowers-project-root'), '', 'utf8');

  const markedPlan = await planProjectInitialization({ cwd: marked, homeDir: homedir(), tempDir: tmpdir() });

  assert.equal(markedPlan.eligibility, 'project');
  assert.equal(markedPlan.project_root, marked);
});

test('does not use a marker above a Git root as the project root', async () => {
  const container = await retainedFixture('marker-above-git-root');
  const gitRoot = path.join(container, 'repository');
  const nested = path.join(gitRoot, 'src/feature');
  await mkdir(nested, { recursive: true });
  await run('git', ['init', '--quiet'], { cwd: gitRoot });
  await run('git', ['remote', 'add', 'origin', 'https://github.com/example/fixture.git'], { cwd: gitRoot });
  await writeFile(path.join(container, '.horspowers-project-root'), '', 'utf8');

  const plan = await planProjectInitialization({ cwd: nested, homeDir: homedir(), tempDir: tmpdir() });
  const result = await applyProjectInitialization(plan);

  assert.equal(plan.eligibility, 'project');
  assert.equal(plan.project_root, gitRoot);
  assert.equal(result.config.status, 'created');
  assert.equal(result.docs.status, 'created');
  await access(path.join(gitRoot, '.horspowers-config.yaml'), constants.F_OK);
  await assert.rejects(access(path.join(container, '.horspowers-config.yaml'), constants.F_OK));
  await assert.rejects(access(path.join(container, 'docs'), constants.F_OK));
});

test('continues to find a marker nested inside a confirmed Git root', async () => {
  const gitRoot = await gitFixture('marker-inside-git-root');
  const markedRoot = path.join(gitRoot, 'packages/widget');
  const nested = path.join(markedRoot, 'src');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(markedRoot, '.horspowers-project-root'), '', 'utf8');

  const plan = await planProjectInitialization({ cwd: nested, homeDir: homedir(), tempDir: tmpdir() });

  assert.equal(plan.eligibility, 'project');
  assert.equal(plan.project_root, markedRoot);
  assert.equal(plan.config_action, 'create');
});

test('does not let a marker initialize directories without a confirmed ordinary Git remote', async () => {
  const unconfirmedGitRoot = await retainedFixture('marked-unconfirmed-git');
  const noRemoteRoot = await gitFixture('marked-no-remote', { remoteUrl: null });
  await writeFile(path.join(unconfirmedGitRoot, '.git'), 'not a gitdir\n', 'utf8');
  const cases = [
    {
      root: unconfirmedGitRoot,
      expectedPlan: { eligibility: 'skipped', reason: 'not_a_project' },
      expectedResult: { config: { status: 'skipped' }, docs: { status: 'skipped' } }
    },
    {
      root: noRemoteRoot,
      expectedPlan: { eligibility: 'external_project', reason: 'unregistered_no_remote' },
      expectedResult: { config: { status: 'external_required' }, docs: { status: 'skipped' } }
    }
  ];

  for (const { root, expectedPlan, expectedResult } of cases) {
    await writeFile(path.join(root, '.horspowers-project-root'), '', 'utf8');
    const before = await snapshotTree(root);
    const plan = await planProjectInitialization({ cwd: root, homeDir: homedir(), tempDir: tmpdir() });
    const result = await applyProjectInitialization(plan);
    const after = await snapshotTree(root);

    assert.deepEqual(after, before, root);
    assert.equal(plan.eligibility, expectedPlan.eligibility, root);
    assert.equal(plan.reason, expectedPlan.reason, root);
    assert.deepEqual(result, expectedResult, root);
  }
});

test('rejects sensitive roots, opt-out projects, Wiki-native projects, and Wiki symlinks', async () => {
  const optOut = await gitFixture('opt-out');
  const wiki = await retainedFixture('wiki-native');
  const wikiLink = await retainedFixture('wiki-link');
  await writeFile(path.join(optOut, '.horspowers-no-auto-init'), '', 'utf8');
  await mkdir(path.join(wiki, 'wiki'), { recursive: true });
  await mkdir(path.join(wiki, 'schema'), { recursive: true });
  await writeFile(path.join(wiki, 'wiki/index.md'), '# Wiki\n', 'utf8');
  await writeFile(path.join(wiki, 'schema/wiki-native-automation.md'), '# Native\n', 'utf8');
  await symlink(wiki, path.join(wikiLink, 'linked-wiki'));

  const cases = [
    [path.parse(repoRoot).root, 'sensitive_root'],
    [homedir(), 'sensitive_root'],
    [tmpdir(), 'sensitive_root'],
    [path.join(tmpdir(), 'child'), 'sensitive_root'],
    [optOut, 'opt_out'],
    [wiki, 'wiki_native'],
    [path.join(wikiLink, 'linked-wiki'), 'wiki_native']
  ];

  for (const [cwd, reason] of cases) {
    const plan = await planProjectInitialization({ cwd, homeDir: homedir(), tempDir: tmpdir() });
    assert.equal(plan.eligibility, 'skipped', cwd);
    assert.equal(plan.reason, reason, cwd);
  }
});

test('creates team configuration atomically without changing an existing valid file', async () => {
  const root = await gitFixture('atomic-config');
  const configPath = path.join(root, '.horspowers-config.yaml');

  const first = await initializeConfigIfMissing(root, 'team');
  assert.equal(first.status, 'created');
  const before = await readFile(configPath);
  const second = await initializeConfigIfMissing(root, 'team');
  const after = await readFile(configPath);

  assert.equal(second.status, 'exists');
  assert.equal(second.config_state, 'valid');
  assert.deepEqual(after, before);
});

test('never overwrites disabled, invalid, legacy, or concurrently created configurations', async () => {
  const disabledRoot = await gitFixture('disabled-config');
  const invalidRoot = await gitFixture('invalid-config');
  const legacyRoot = await gitFixture('legacy-config');
  const concurrentRoot = await gitFixture('concurrent-config');
  const disabledPath = path.join(disabledRoot, '.horspowers-config.yaml');
  const invalidPath = path.join(invalidRoot, '.horspowers-config.yaml');
  const legacyPath = path.join(legacyRoot, '.superpowers-config.yaml');
  await writeFile(disabledPath, teamConfig({ documentationEnabled: false }), 'utf8');
  await writeFile(invalidPath, 'development_mode: invalid\n', 'utf8');
  await writeFile(legacyPath, 'development_mode: personal\n', 'utf8');

  const disabledBefore = await readFile(disabledPath);
  const invalidBefore = await readFile(invalidPath);
  const legacyBefore = await readFile(legacyPath);
  const [disabled, invalid, legacy, firstConcurrent, secondConcurrent] = await Promise.all([
    initializeConfigIfMissing(disabledRoot, 'team'),
    initializeConfigIfMissing(invalidRoot, 'team'),
    initializeConfigIfMissing(legacyRoot, 'team'),
    initializeConfigIfMissing(concurrentRoot, 'team'),
    initializeConfigIfMissing(concurrentRoot, 'team')
  ]);

  assert.deepEqual(await readFile(disabledPath), disabledBefore);
  assert.deepEqual(await readFile(invalidPath), invalidBefore);
  assert.deepEqual(await readFile(legacyPath), legacyBefore);
  assert.equal(disabled.status, 'exists');
  assert.equal(disabled.config_state, 'valid');
  assert.equal(invalid.status, 'exists');
  assert.equal(invalid.config_state, 'invalid');
  assert.equal(legacy.status, 'exists');
  assert.equal(legacy.config_state, 'needs_migration');
  assert.deepEqual(new Set([firstConcurrent.status, secondConcurrent.status]), new Set(['created', 'exists']));
  assert.equal((firstConcurrent.status === 'exists' ? firstConcurrent : secondConcurrent).config_state, 'valid');
});

test('plans and applies only safe config and docs mutations', async () => {
  const freshRoot = await gitFixture('apply-fresh');
  const disabledRoot = await gitFixture('apply-disabled');
  const invalidRoot = await gitFixture('apply-invalid');
  await writeFile(path.join(disabledRoot, '.horspowers-config.yaml'), teamConfig({ documentationEnabled: false }), 'utf8');
  await writeFile(path.join(invalidRoot, '.horspowers-config.yaml'), 'development_mode: invalid\n', 'utf8');

  const freshPlan = await planProjectInitialization({ cwd: freshRoot, homeDir: homedir(), tempDir: tmpdir() });
  const freshResult = await applyProjectInitialization(freshPlan);
  assert.equal(freshResult.config.status, 'created');
  assert.equal(freshResult.docs.status, 'created');
  assert.equal((await planProjectInitialization({ cwd: freshRoot, homeDir: homedir(), tempDir: tmpdir() })).docs_action, 'unchanged');

  const disabledPlan = await planProjectInitialization({ cwd: disabledRoot, homeDir: homedir(), tempDir: tmpdir() });
  const invalidPlan = await planProjectInitialization({ cwd: invalidRoot, homeDir: homedir(), tempDir: tmpdir() });
  assert.equal(disabledPlan.docs_action, 'skipped_disabled');
  assert.equal(invalidPlan.config_action, 'explicit_action_required_invalid');
  assert.deepEqual(await applyProjectInitialization(disabledPlan), { config: { status: 'unchanged' }, docs: { status: 'skipped_disabled' } });
  assert.deepEqual(await applyProjectInitialization(invalidPlan), { config: { status: 'explicit_action_required' }, docs: { status: 'skipped' } });
});

test('requires external configuration without changing company project files', async () => {
  const missingConfigRoot = await gitFixture('company-missing-config', {
    remoteUrl: 'git@gitlab.ugnas.com:platform/ugcli-lib.git'
  });
  const existingConfigRoot = await gitFixture('company-existing-config', {
    remoteUrl: 'ssh://git@192.168.75.113:2222/platform/ugcli-lib.git'
  });
  await writeFile(path.join(existingConfigRoot, '.horspowers-config.yaml'), teamConfig(), 'utf8');

  for (const root of [missingConfigRoot, existingConfigRoot]) {
    const plan = await planProjectInitialization({ cwd: root, homeDir: homedir(), tempDir: tmpdir() });
    assert.equal(plan.eligibility, 'external_project');
    assert.equal(plan.reason, 'company_external_config_required');
    assert.equal(plan.config_action, 'external_required');
    assert.equal(plan.docs_action, 'skipped');

    const before = await snapshotTree(root);
    const result = await applyProjectInitialization(plan);
    const after = await snapshotTree(root);
    assert.deepEqual(after, before);
    assert.equal(result.config.status, 'external_required');
    assert.equal(result.docs.status, 'skipped');
  }
});

test('detects company remotes before local Wiki and project-marker probes', async () => {
  const root = await gitFixture('company-priority', {
    remoteUrl: 'git@gitlab.ugnas.com:platform/ugcli-lib.git'
  });
  await mkdir(path.join(root, 'wiki'), { recursive: true });
  await mkdir(path.join(root, 'schema'), { recursive: true });
  await writeFile(path.join(root, 'wiki/index.md'), '# Wiki\n', 'utf8');
  await writeFile(path.join(root, 'schema/wiki-native-automation.md'), '# Native\n', 'utf8');
  await writeFile(path.join(root, '.horspowers-project-root'), '', 'utf8');

  const plan = await planProjectInitialization({ cwd: root, homeDir: homedir(), tempDir: tmpdir() });

  assert.equal(plan.eligibility, 'external_project');
  assert.equal(plan.reason, 'company_external_config_required');
});

test('does not initialize repositories without an unambiguous external remote', async () => {
  const noRemoteRoot = await gitFixture('no-remote', { remoteUrl: null });
  const ambiguousRoot = await gitFixture('ambiguous-company', { remoteUrl: null });
  await run('git', ['remote', 'add', 'upstream', 'git@gitlab.ugnas.com:platform/one.git'], { cwd: ambiguousRoot });
  await run('git', ['remote', 'add', 'backup', 'git@192.168.75.113:platform/two.git'], { cwd: ambiguousRoot });

  const noRemotePlan = await planProjectInitialization({ cwd: noRemoteRoot, homeDir: homedir(), tempDir: tmpdir() });
  const ambiguousPlan = await planProjectInitialization({ cwd: ambiguousRoot, homeDir: homedir(), tempDir: tmpdir() });

  assert.deepEqual(
    { eligibility: noRemotePlan.eligibility, reason: noRemotePlan.reason, config_action: noRemotePlan.config_action, docs_action: noRemotePlan.docs_action },
    { eligibility: 'external_project', reason: 'unregistered_no_remote', config_action: 'external_required', docs_action: 'skipped' }
  );
  assert.deepEqual(
    { eligibility: ambiguousPlan.eligibility, reason: ambiguousPlan.reason, config_action: ambiguousPlan.config_action, docs_action: ambiguousPlan.docs_action },
    { eligibility: 'external_project', reason: 'ambiguous_company_remote', config_action: 'external_required', docs_action: 'skipped' }
  );
});

test('recognizes an unwritable project when the platform enforces owner write bits', async (t) => {
  const root = await gitFixture('unwritable');
  await chmod(root, 0o500);
  t.after(async () => { await chmod(root, 0o700); });

  try {
    await access(root, constants.W_OK);
  } catch {
    const plan = await planProjectInitialization({ cwd: root, homeDir: homedir(), tempDir: tmpdir() });
    assert.equal(plan.eligibility, 'skipped');
    assert.equal(plan.reason, 'not_writable');
    return;
  }
  t.skip('platform does not enforce owner write bits for this test process');
});
