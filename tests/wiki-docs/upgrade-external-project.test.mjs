import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { VersionUpgrader } = require('../../lib/version-upgrade.js');
const execFileAsync = promisify(execFile);

const companyUrls = [
  'git@gitlab.ugnas.com:group/project.git',
  'ssh://git@gitlab.ugnas.com/group/project.git',
  'https://gitlab.ugnas.com/group/project.git',
  'git@192.168.75.113:group/project.git',
  'ssh://git@192.168.75.113/group/project.git'
];

async function runGit(root, args) {
  await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
}

async function fixture({ remotes = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'horspowers-upgrade-external-'));
  await runGit(root, ['init', '--quiet']);
  for (const { name, url } of remotes) await runGit(root, ['remote', 'add', name, url]);
  await mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await mkdir(path.join(root, 'docs', 'active'), { recursive: true });
  await mkdir(path.join(root, 'document-driven-ai-workflow'), { recursive: true });
  await writeFile(path.join(root, '.horspowers-version'), '4.1.0\n', 'utf8');
  await writeFile(path.join(root, '.horspowers-config.yaml'), 'documentation.enabled: true\n', 'utf8');
  await writeFile(path.join(root, 'docs', 'plans', 'existing-plan.md'), '# Existing plan\n', 'utf8');
  await writeFile(path.join(root, 'docs', 'active', 'existing-task.md'), '# Existing task\n', 'utf8');
  await writeFile(path.join(root, 'document-driven-ai-workflow', 'legacy.md'), '# Legacy\n', 'utf8');
  return root;
}

async function snapshot(root, current = '') {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.git') continue;
    const relative = path.join(current, entry.name);
    if (entry.isDirectory()) {
      result[relative] = await snapshot(root, relative);
    } else {
      result[relative] = await readFile(path.join(root, relative), 'utf8');
    }
  }
  return result;
}

async function expectNoMutation(root, expectedStatus) {
  const before = await snapshot(root);
  const upgrader = new VersionUpgrader(root);
  upgrader.hasOldVersionMarker = () => {
    throw new Error('project identity must be checked before reading the version marker');
  };
  upgrader.detectDDAWDirectory = () => {
    throw new Error('project identity must be checked before inspecting legacy directories');
  };
  const result = await upgrader.run({ quiet: true, skipDDAW: true, skipDocs: true });
  assert.equal(result.status, expectedStatus);
  assert.equal(result.no_mutation, true);
  assert.deepEqual(await snapshot(root), before);
}

for (const remoteUrl of companyUrls) {
  test(`company remote ${remoteUrl} never upgrades or mutates project files`, async (t) => {
    const root = await fixture({ remotes: [{ name: 'origin', url: remoteUrl }] });
    t.after(() => rm(root, { recursive: true, force: true }));
    await expectNoMutation(root, 'external_project_upgrade_disabled');
  });
}

test('ambiguous company remotes are explicit no-mutation failures', async (t) => {
  const root = await fixture({
    remotes: [
      { name: 'company-a', url: 'git@gitlab.ugnas.com:group/a.git' },
      { name: 'company-b', url: 'ssh://git@192.168.75.113/group/b.git' }
    ]
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await expectNoMutation(root, 'ambiguous_project_upgrade_disabled');
});

test('projects without a remote are explicit no-mutation failures', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await expectNoMutation(root, 'no_remote_project_upgrade_disabled');
});

test('ordinary external projects retain their existing upgrade marker behavior', async (t) => {
  const root = await fixture({ remotes: [{ name: 'origin', url: 'https://github.com/example/project.git' }] });
  t.after(() => rm(root, { recursive: true, force: true }));
  const upgrader = new VersionUpgrader(root);
  const result = await upgrader.run({ quiet: true, skipDDAW: true, skipDocs: true });
  assert.equal(result.success, true);
  assert.notEqual(await readFile(path.join(root, '.horspowers-version'), 'utf8'), '4.1.0\n');
});
