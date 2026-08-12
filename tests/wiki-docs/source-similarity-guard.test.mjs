import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { scanSourceSimilarity } from '../../lib/source-similarity-guard.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactsRoot = path.join(repoRoot, 'tests/.artifacts/wiki-docs');
let fixtureSequence = 0;

async function runGit(root, args) {
  await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false });
}

async function retainedGitFixture(name) {
  const root = path.join(artifactsRoot, `${Date.now()}-${process.pid}-${fixtureSequence += 1}-${name}`);
  await mkdir(root, { recursive: true });
  await runGit(root, ['init', '-q']);
  await runGit(root, ['config', 'user.email', 'fixture@example.invalid']);
  await runGit(root, ['config', 'user.name', 'fixture']);
  return root;
}

function candidate(value) {
  return [{ path: '$.sections[0].paragraphs[0]', value }];
}

test('fails closed when a nontrivial source line or 20-character source window is copied', async () => {
  const root = await retainedGitFixture('tracked-source');
  const source = 'const canonicalEvidence = "a nontrivial tracked source sentence";\n';
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'evidence.js'), source, 'utf8');
  await runGit(root, ['add', 'src/evidence.js']);

  const exact = await scanSourceSimilarity({ projectRoot: root, texts: candidate(source.trim()) });
  const window = await scanSourceSimilarity({
    projectRoot: root,
    texts: candidate('nontrivial tracked source sentence')
  });

  assert.equal(exact.ok, false);
  assert.equal(exact.error_code, 'raw_source_detected');
  assert.equal(window.ok, false);
  assert.equal(window.error_code, 'raw_source_detected');
  assert.equal(JSON.stringify(exact).includes('canonicalEvidence'), false);
});

test('scans both tracked and untracked nonignored text, while ignoring ignored and binary files', async () => {
  const root = await retainedGitFixture('tracked-untracked');
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n', 'utf8');
  await writeFile(path.join(root, 'tracked.txt'), 'tracked evidence with enough distinct content\n', 'utf8');
  await writeFile(path.join(root, 'untracked.txt'), 'untracked evidence with enough distinct content\n', 'utf8');
  await writeFile(path.join(root, 'ignored.txt'), 'zebra quartz nebula isolated ignored material\n', 'utf8');
  await writeFile(path.join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));
  await runGit(root, ['add', '.gitignore', 'tracked.txt', 'binary.bin']);

  const tracked = await scanSourceSimilarity({
    projectRoot: root,
    texts: candidate('tracked evidence with enough distinct content')
  });
  const untracked = await scanSourceSimilarity({
    projectRoot: root,
    texts: candidate('untracked evidence with enough distinct content')
  });
  const ignored = await scanSourceSimilarity({
    projectRoot: root,
    texts: candidate('zebra quartz nebula isolated ignored material')
  });
  const binary = await scanSourceSimilarity({ projectRoot: root, texts: candidate('small generic example') });

  assert.equal(tracked.error_code, 'raw_source_detected');
  assert.equal(untracked.error_code, 'raw_source_detected');
  assert.equal(ignored.ok, true);
  assert.equal(binary.ok, true);
});

test('fails closed on scan budget exhaustion and never modifies the Git fixture', async () => {
  const root = await retainedGitFixture('budget');
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(200) + '\n', 'utf8');
  await runGit(root, ['add', 'large.txt']);
  const before = (await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1'], { encoding: 'utf8', shell: false })).stdout;

  const result = await scanSourceSimilarity({
    projectRoot: root,
    texts: candidate('small generic example'),
    limits: { maxTotalBytes: 1 }
  });
  const after = (await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1'], { encoding: 'utf8', shell: false })).stdout;

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'source_scan_incomplete');
  assert.equal(after, before);
  assert.equal((await readFile(path.join(root, 'large.txt'), 'utf8')).length, 201);
});

test('does not allow callers to raise the fixed source-scan budgets', async () => {
  const root = await retainedGitFixture('fixed-budgets');
  await writeFile(path.join(root, 'evidence.txt'), 'bounded source evidence\n', 'utf8');
  await runGit(root, ['add', 'evidence.txt']);

  const result = await scanSourceSimilarity({
    projectRoot: root,
    texts: candidate('small generic example'),
    limits: { maxFiles: 10_001 }
  });

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'source_scan_incomplete');
});

test('fails closed when the wall-clock budget is exhausted during source matching', async () => {
  const root = await retainedGitFixture('matching-deadline');
  await writeFile(path.join(root, 'evidence.txt'), 'bounded source evidence that does not contain the candidate\n', 'utf8');
  await runGit(root, ['add', 'evidence.txt']);

  const originalNow = Date.now;
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return calls <= 5 ? 0 : 6_000;
  };
  try {
    const result = await scanSourceSimilarity({
      projectRoot: root,
      texts: candidate('a distinct candidate with at least twenty characters')
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_code, 'source_scan_incomplete');
  } finally {
    Date.now = originalNow;
  }
});
