import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const { MigrationPlan, executeMigration } = require('../../scripts/migrate-docs.js');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const migrationScript = path.join(repoRoot, 'scripts/migrate-docs.js');
const execFileAsync = promisify(execFile);

async function runGit(root, args) {
  await execFileAsync('git', ['-C', root, ...args], { windowsHide: true });
}

async function fixture({ remotes = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'horspowers-migrate-runtime-'));
  await runGit(root, ['init', '--quiet']);
  for (const { name, url } of remotes) await runGit(root, ['remote', 'add', name, url]);
  await mkdir(path.join(root, 'docs', 'plans'), { recursive: true });
  await writeFile(
    path.join(root, 'docs', 'plans', '2026-08-10-runtime-boundary-design.md'),
    '# Runtime boundary\n',
    'utf8'
  );
  await writeFile(
    path.join(root, 'docs', 'plans', 'guide.md'),
    '[Runtime boundary](2026-08-10-runtime-boundary-design.md)\n',
    'utf8'
  );
  return root;
}

async function snapshot(directory, relative = '') {
  const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      result[entryRelative] = await snapshot(directory, entryRelative);
    } else {
      result[entryRelative] = await readFile(path.join(directory, entryRelative), 'utf8');
    }
  }
  return result;
}

async function runMigration(root, args = []) {
  try {
    const result = await execFileAsync(process.execPath, [migrationScript, ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      exitCode: typeof error.code === 'number' ? error.code : 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? '')
    };
  }
}

test('unsupported legacy migration returns a fail-closed no-mutation result', () => {
  const result = executeMigration(new MigrationPlan());

  assert.equal(result.success, false);
  assert.equal(result.status, 'legacy_document_migration_not_supported_by_runtime');
  assert.equal(result.no_mutation, true);
});

for (const [identity, remotes] of [
  ['company', [{ name: 'origin', url: 'git@gitlab.ugnas.com:group/project.git' }]],
  ['ambiguous_company_remote', [
    { name: 'company-a', url: 'git@gitlab.ugnas.com:group/a.git' },
    { name: 'company-b', url: 'git@192.168.75.113:group/b.git' }
  ]],
  ['none', []]
]) {
  test(`${identity} projects fail before legacy migration can change local docs`, async (t) => {
    const root = await fixture({ remotes });
    t.after(() => rm(root, { recursive: true, force: true }));
    const before = await snapshot(path.join(root, 'docs'));

    const result = await runMigration(root);

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(`external-document-runtime-not-ready \\(${identity}\\)`, 'u'));
    assert.deepEqual(await snapshot(path.join(root, 'docs')), before);
  });
}

test('ordinary external projects retain a read-only dry run and block unsupported mutation', async (t) => {
  const root = await fixture({ remotes: [{ name: 'origin', url: 'https://github.com/example/project.git' }] });
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await snapshot(path.join(root, 'docs'));

  const dryRun = await runMigration(root, ['--dry-run']);
  assert.equal(dryRun.exitCode, 0);
  assert.match(dryRun.stdout, /预览完成/u);
  assert.deepEqual(await snapshot(path.join(root, 'docs')), before);

  const blocked = await runMigration(root);
  assert.notEqual(blocked.exitCode, 0);
  assert.match(blocked.stdout, /legacy_document_migration_not_supported_by_runtime/u);
  assert.deepEqual(await snapshot(path.join(root, 'docs')), before);
});
