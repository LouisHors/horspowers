import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ensureDocsInitialized } = require('../../lib/docs-core.js');
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

test('creates the required docs structure once and remains unchanged on repeat', async () => {
  const root = await retainedFixture('docs-first');

  const first = ensureDocsInitialized(root);
  const second = ensureDocsInitialized(root);

  assert.equal(first.status, 'created');
  assert.equal(second.status, 'unchanged');
  for (const relativePath of ['docs/plans', 'docs/active', 'docs/archive', 'docs/context', 'docs/.docs-metadata/index.json']) {
    await access(path.join(root, relativePath), constants.F_OK);
  }
});

test('repairs missing structure without overwriting existing index or Markdown', async () => {
  const root = await retainedFixture('docs-preserve');
  const docsRoot = path.join(root, 'docs');
  const metadataRoot = path.join(docsRoot, '.docs-metadata');
  await mkdir(metadataRoot, { recursive: true });
  const indexPath = path.join(metadataRoot, 'index.json');
  const markdownPath = path.join(docsRoot, 'README.md');
  await writeFile(indexPath, '{"preserve":true}\n', 'utf8');
  await writeFile(markdownPath, '# Preserve me\n', 'utf8');
  const originalIndex = await readFile(indexPath);
  const originalMarkdown = await readFile(markdownPath);

  const result = ensureDocsInitialized(root);

  assert.equal(result.status, 'updated');
  assert.deepEqual(await readFile(indexPath), originalIndex);
  assert.deepEqual(await readFile(markdownPath), originalMarkdown);
});
