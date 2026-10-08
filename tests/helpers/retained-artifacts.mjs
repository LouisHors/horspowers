/**
 * Retention for the retained test fixtures under `tests/.artifacts`.
 *
 * Those fixtures are deliberately kept for debugging, but nothing bounded
 * them: a repository could accumulate tens of thousands of directories and
 * hundreds of megabytes, and every repo-wide audit walked them. This helper
 * enforces a simple cap while staying safe to call from suites that run in
 * parallel.
 *
 * The age floor is the safety property: a fixture written by a concurrently
 * running test file is younger than the floor, so the cap never deletes a
 * fixture that another process may still be using.
 *
 * `tests/wiki-docs/skill-document-runtime-contract.test.mjs` skips
 * `.artifacts` when it audits the repository, so pruning cannot race that
 * audit.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_KEEP = 40;
export const DEFAULT_MIN_AGE_MS = 60_000;

/**
 * Remove retained fixtures beyond the newest `keep` entries.
 * @param {string} root
 * @param {{keep?: number, minAgeMs?: number, now?: number}} [options]
 * @returns {Promise<{removed: string[], kept: number, skippedFresh: number, skipped?: string}>}
 */
export async function pruneRetainedArtifacts(root, {
  keep = DEFAULT_KEEP,
  minAgeMs = DEFAULT_MIN_AGE_MS,
  now = Date.now()
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('retained artifacts root must be an absolute path');
  }
  if (!Number.isSafeInteger(keep) || keep < 0) throw new TypeError('keep must be a non-negative integer');
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) throw new TypeError('minAgeMs must be a non-negative number');

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: [], kept: 0, skippedFresh: 0, skipped: 'missing' };
    throw error;
  }

  const stamped = [];
  for (const entry of entries) {
    try {
      const info = await stat(path.join(root, entry.name));
      stamped.push({ name: entry.name, mtimeMs: info.mtimeMs });
    } catch { /* the entry vanished while listing; nothing to prune */ }
  }
  stamped.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const beyondCap = stamped.slice(keep);
  const expired = beyondCap.filter((entry) => now - entry.mtimeMs >= minAgeMs);
  const removed = [];
  for (const entry of expired) {
    try {
      await rm(path.join(root, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch { /* a concurrent prune already removed it */ }
  }
  return {
    removed: removed.sort(),
    kept: stamped.length - removed.length,
    skippedFresh: beyondCap.length - removed.length
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [root, ...rest] = process.argv.slice(2);
  if (typeof root !== 'string' || root.length === 0) {
    process.stderr.write('Usage: node tests/helpers/retained-artifacts.mjs <absolute-root> [--keep <count>]\n');
    process.exitCode = 2;
  } else {
    let keep = DEFAULT_KEEP;
    const flag = rest.indexOf('--keep');
    if (flag !== -1) {
      const value = Number(rest[flag + 1]);
      if (!Number.isSafeInteger(value) || value < 0) {
        process.stderr.write('--keep must be a non-negative integer\n');
        process.exitCode = 2;
      } else {
        keep = value;
      }
    }
    if (process.exitCode !== 2) {
      process.stdout.write(`${JSON.stringify(await pruneRetainedArtifacts(root, { keep }))}\n`);
    }
  }
}
