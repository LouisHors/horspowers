import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { LocalDocsBackend } from '../../lib/document-backends/local-docs-backend.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactsRoot = path.join(repoRoot, 'tests/.artifacts/wiki-docs');
let fixtureSequence = 0;

async function retainedFixture(name) {
  const root = path.join(
    artifactsRoot,
    `${Date.now()}-${process.pid}-${fixtureSequence += 1}-${name}`
  );
  await mkdir(root, { recursive: true });
  return root;
}

function assertLocalResult(result) {
  assert.equal(typeof result.status, 'string');
  assert.equal(result.backend, 'local');
  assert.equal(result.project_id, 'fixture/local-docs');
}

test('adapts local docs operations to one result envelope without changing naming or directories', async () => {
  const root = await retainedFixture('operations');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });

  const created = await backend.create({
    document_type: 'task',
    title: 'Runtime adapter fixture',
    content: '# Runtime adapter fixture\n\n## 基本信息\n- 状态: 待开始\n'
  });
  assertLocalResult(created);
  assert.equal(created.status, 'created');
  assert.match(created.document.path, /docs[\\/]active[\\/]\d{4}-\d{2}-\d{2}-task-runtime-adapter-fixture\.md$/u);

  const fetched = await backend.get({ path: created.document.path });
  assertLocalResult(fetched);
  assert.equal(fetched.status, 'ok');
  assert.match(fetched.document.content, /Runtime adapter fixture/u);

  const searched = await backend.search({ query: 'Runtime adapter fixture' });
  assertLocalResult(searched);
  assert.equal(searched.status, 'ok');
  assert.ok(searched.documents.some(document => document.path === created.document.path));

  const updated = await backend.update({
    path: created.document.path,
    updates: { status: '进行中', progress: '通过统一本地 adapter 更新' }
  });
  assertLocalResult(updated);
  assert.equal(updated.status, 'updated');
  const updatedContent = await readFile(created.document.path, 'utf8');
  assert.match(updatedContent, /状态: 进行中/u);
  assert.match(updatedContent, /通过统一本地 adapter 更新/u);

  const archived = await backend.archive({ path: created.document.path });
  assertLocalResult(archived);
  assert.equal(archived.status, 'archived');
  assert.match(archived.document.path, /docs[\\/]archive[\\/]/u);

  const restored = await backend.restore({ path: archived.document.path });
  assertLocalResult(restored);
  assert.equal(restored.status, 'restored');
  assert.match(restored.document.path, /docs[\\/]active[\\/]/u);

  const recorded = await backend.recordSession({
    session: {
      session_id: 'session-runtime-fixture',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [{ document_type: 'task', path: restored.document.path }],
    auto_archive_completed: false
  });
  assertLocalResult(recorded);
  assert.equal(recorded.status, 'recorded');
  assert.equal(recorded.session.session_id, 'session-runtime-fixture');
});

test('rejects traversal and symlink escapes for every local document target', async () => {
  const root = await retainedFixture('path-boundary');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const outsidePath = path.join(root, 'outside.md');
  await writeFile(outsidePath, '# outside\n', 'utf8');

  const traversal = await backend.get({ path: '../outside.md' });
  assertLocalResult(traversal);
  assert.equal(traversal.status, 'invalid_request');
  assert.equal(traversal.error_code, 'document_path_outside_docs');

  const escapedLink = path.join(root, 'docs', 'active', 'escape.md');
  await symlink(outsidePath, escapedLink);
  const symlinkResult = await backend.update({ path: escapedLink, updates: { content: '# changed\n' } });
  assertLocalResult(symlinkResult);
  assert.equal(symlinkResult.status, 'invalid_request');
  assert.equal(symlinkResult.error_code, 'document_path_outside_docs');
  assert.equal(await readFile(outsidePath, 'utf8'), '# outside\n');
});

test('refuses an archive directory symlink instead of moving a document outside docs', async () => {
  const root = await retainedFixture('archive-target-boundary');
  const outsideArchive = path.join(root, 'outside-archive');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await mkdir(outsideArchive, { recursive: true });
  await symlink(outsideArchive, path.join(root, 'docs', 'archive'));

  assert.throws(
    () => new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' }),
    /docs|outside|path/i
  );
  assert.deepEqual(await readdir(outsideArchive), []);
});

test('refuses to initialize a local backend through a docs symlink', async () => {
  const root = await retainedFixture('docs-root-boundary');
  const outsideDocs = path.join(root, 'outside-docs');
  await mkdir(outsideDocs, { recursive: true });
  await symlink(outsideDocs, path.join(root, 'docs'));

  assert.throws(
    () => new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' }),
    /docs|outside|path/i
  );
  assert.deepEqual(await readdir(outsideDocs), []);
});

test('does not report a session as recorded when local metadata persistence fails', async () => {
  const root = await retainedFixture('session-failure');
  const backend = new LocalDocsBackend({
    projectRoot: root,
    projectId: 'fixture/local-docs',
    manager: {
      setCheckpoint: () => ({ success: false, error_code: 'document_path_outside_docs' })
    }
  });

  const result = await backend.recordSession({
    session: {
      session_id: 'session-failure-fixture',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [],
    auto_archive_completed: false
  });

  assertLocalResult(result);
  assert.equal(result.status, 'invalid_request');
  assert.equal(result.error_code, 'document_path_outside_docs');
});
