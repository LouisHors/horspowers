import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { pruneRetainedArtifacts } from './retained-artifacts.mjs';

const execFileAsync = promisify(execFile);
const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'retained-artifacts.mjs');

const NOW = Date.UTC(2026, 9, 8, 6, 0, 0);

/** Create `count` entries whose mtimes are `ageMs` old, one second apart. */
async function seed(root, prefix, count, ageMs) {
  await mkdir(root, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const entry = path.join(root, `${prefix}-${String(index).padStart(3, '0')}`);
    await mkdir(entry, { recursive: true });
    await writeFile(path.join(entry, 'fixture.txt'), `${index}\n`, 'utf8');
    const seconds = (NOW - ageMs - index * 1_000) / 1_000;
    await utimes(entry, seconds, seconds);
  }
}

async function names(root) {
  return (await readdir(root)).sort();
}

test('retained artifacts are capped to the newest entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hps-retention-'));
  try {
    await seed(root, 'run', 10, 3_600_000);
    const result = await pruneRetainedArtifacts(root, { keep: 4, minAgeMs: 60_000, now: NOW });

    const remaining = await names(root);
    assert.equal(remaining.length, 4, `expected 4 entries, got ${JSON.stringify(remaining)}`);
    // Newest are index 000..003 because later entries are older.
    assert.deepEqual(remaining, ['run-000', 'run-001', 'run-002', 'run-003']);
    assert.deepEqual(result.removed.sort(), ['run-004', 'run-005', 'run-006', 'run-007', 'run-008', 'run-009']);
    assert.equal(result.kept, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('entries younger than the age floor are never removed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hps-retention-'));
  try {
    // Nine entries, all newer than the floor and all beyond the cap: a
    // concurrent test process may still be writing them, so the cap must not
    // delete them.
    await seed(root, 'new', 9, 0);
    const result = await pruneRetainedArtifacts(root, { keep: 4, minAgeMs: 60_000, now: NOW });

    assert.equal((await names(root)).length, 9);
    assert.deepEqual(result.removed, []);
    assert.equal(result.skippedFresh, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing root is not an error', async () => {
  const root = path.join(tmpdir(), `hps-retention-absent-${process.pid}-${Date.now()}`);
  const result = await pruneRetainedArtifacts(root, { now: NOW });
  assert.deepEqual(result.removed, []);
  assert.equal(result.kept, 0);
  assert.equal(result.skipped, 'missing');
});

test('the helper works as a command so shell suites can prune too', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hps-retention-cli-'));
  try {
    await seed(root, 'run', 6, 3_600_000);
    const { stdout } = await execFileAsync(process.execPath, [helperPath, root, '--keep', '2']);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.kept, 2);
    assert.equal((await names(root)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
