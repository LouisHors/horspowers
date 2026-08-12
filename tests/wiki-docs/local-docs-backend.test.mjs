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
    content: '# Runtime adapter fixture\n\n## 基本信息\n- 状态: 待开始\n\n## 进展记录\n- 2026-08-10: 创建任务\n'
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
    document_refs: [{ document_type: 'task', logical_id: 'runtime-adapter-fixture' }],
    auto_archive_completed: false
  });
  assertLocalResult(recorded);
  assert.equal(recorded.status, 'recorded');
  assert.equal(recorded.session.session_id, 'session-runtime-fixture');
  assert.match(await readFile(restored.document.path, 'utf8'), /Session ended at 2026-08-10T00:00:00Z/u);
});

test('persists a repeated progress value as a new local progress entry', async () => {
  const root = await retainedFixture('repeated-progress');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const created = await backend.create({
    document_type: 'task',
    title: 'Repeated progress task',
    content: '# Repeated progress task\n\n## 基本信息\n- 状态: 进行中\n\n## 进展记录\n- 2026-08-10: same progress\n'
  });

  const updated = await backend.update({
    path: created.document.path,
    updates: { progress: 'same progress' }
  });

  assertLocalResult(updated);
  assert.equal(updated.status, 'updated');
  const content = await readFile(created.document.path, 'utf8');
  assert.equal((content.match(/same progress/gu) ?? []).length, 2);
});

test('appends progress to an existing CRLF section without creating a duplicate heading', async () => {
  const root = await retainedFixture('crlf-progress');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const created = await backend.create({
    document_type: 'task',
    title: 'CRLF progress task',
    content: '# CRLF progress task\r\n\r\n## 基本信息\r\n- 状态: 进行中\r\n\r\n## 进展记录\r\n- 2026-08-10: initial\r\n'
  });

  const updated = await backend.update({
    path: created.document.path,
    updates: { progress: 'CRLF progress update' }
  });

  assertLocalResult(updated);
  assert.equal(updated.status, 'updated');
  const content = await readFile(created.document.path, 'utf8');
  assert.equal((content.match(/## 进展记录/gu) ?? []).length, 1);
  assert.match(content, /\r\n- \d{4}-\d{2}-\d{2}: CRLF progress update\r\n/u);
});

test('archives every completed local active document when a session has no explicit references', async () => {
  const root = await retainedFixture('unreferenced-completed-session-documents');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const firstCompleted = await backend.create({
    document_type: 'task',
    title: 'First unreferenced complete task',
    content: '# First unreferenced task\n\n## 基本信息\n- 状态: completed\n\n## 进展记录\n- 2026-08-10: ready\n'
  });
  const secondCompleted = await backend.create({
    document_type: 'task',
    title: 'Legacy unreferenced complete task',
    content: '# Legacy unreferenced task\n\n- 状态:已关闭\n'
  });

  const recorded = await backend.recordSession({
    session: {
      session_id: 'unreferenced-completed-session-documents',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [],
    auto_archive_completed: true
  });

  assertLocalResult(recorded);
  assert.equal(recorded.status, 'recorded');
  assert.equal(recorded.archived_count, 2);
  await assert.rejects(readFile(firstCompleted.document.path, 'utf8'), { code: 'ENOENT' });
  await assert.rejects(readFile(secondCompleted.document.path, 'utf8'), { code: 'ENOENT' });
  assert.match(
    await readFile(path.join(root, 'docs', 'archive', path.basename(firstCompleted.document.path)), 'utf8'),
    /First unreferenced task/u
  );
  assert.match(
    await readFile(path.join(root, 'docs', 'archive', path.basename(secondCompleted.document.path)), 'utf8'),
    /Legacy unreferenced task/u
  );
});

test('does not archive an active reference merely because historical progress mentions completion', async () => {
  const root = await retainedFixture('current-status-only');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const active = await backend.create({
    document_type: 'task',
    title: 'Current status task',
    content: '# Current status task\n\n## 基本信息\n- 状态: 进行中\n\n## 进展记录\n- 2026-08-10: historical note\n- 状态: completed\n'
  });

  const recorded = await backend.recordSession({
    session: {
      session_id: 'current-status-only',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [{ document_type: 'task', logical_id: 'current-status-task' }],
    auto_archive_completed: true
  });

  assertLocalResult(recorded);
  assert.equal(recorded.status, 'recorded');
  assert.equal(recorded.archived_count, 0);
  assert.match(await readFile(active.document.path, 'utf8'), /Session ended at 2026-08-10T00:00:00Z/u);
});

test('rolls back earlier local session updates when a later explicit reference fails', async () => {
  const root = await retainedFixture('session-update-rollback');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const first = await backend.create({
    document_type: 'task',
    title: 'First rollback task',
    content: '# First rollback task\n\n## 基本信息\n- 状态: 进行中\n\n## 进展记录\n- 2026-08-10: ready\n'
  });
  const second = await backend.create({
    document_type: 'bug',
    title: 'Second rollback bug',
    content: '# Second rollback bug\n\n## 基本信息\n- 状态: 待修复\n\n## 进展记录\n- 2026-08-10: ready\n'
  });
  const beforeFirst = await readFile(first.document.path, 'utf8');
  const beforeSecond = await readFile(second.document.path, 'utf8');
  const originalUpdate = backend.manager.updateDocument.bind(backend.manager);
  let progressUpdates = 0;
  backend.manager.updateDocument = (documentPath, updates) => {
    if (Object.hasOwn(updates, 'progress') && ++progressUpdates === 2) {
      return { success: false, error_code: 'document_update_failed' };
    }
    return originalUpdate(documentPath, updates);
  };

  const result = await backend.recordSession({
    session: {
      session_id: 'session-update-rollback',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [
      { document_type: 'task', logical_id: 'first-rollback-task' },
      { document_type: 'bug', logical_id: 'second-rollback-bug' }
    ],
    auto_archive_completed: false
  });

  assertLocalResult(result);
  assert.equal(result.status, 'operation_failed');
  assert.equal(result.error_code, 'document_update_failed');
  assert.equal(await readFile(first.document.path, 'utf8'), beforeFirst);
  assert.equal(await readFile(second.document.path, 'utf8'), beforeSecond);
  await assert.rejects(
    readFile(path.join(root, 'docs', '.docs-metadata', 'checkpoints.json'), 'utf8'),
    { code: 'ENOENT' }
  );
});

test('rolls back a local session update that fails after its first document write', async () => {
  const root = await retainedFixture('session-update-mid-write-rollback');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const created = await backend.create({
    document_type: 'task',
    title: 'Mid write rollback task',
    content: '# Mid write rollback task\n\n## 基本信息\n- 状态: 进行中\n\n## 进展记录\n- 2026-08-10: ready\n'
  });
  const before = await readFile(created.document.path, 'utf8');
  const originalUpdate = backend.manager.updateDocument.bind(backend.manager);
  backend.manager.updateDocument = (documentPath, updates) => {
    if (Object.hasOwn(updates, 'progress')) {
      return originalUpdate(documentPath, {
        content: `${before}\n## 临时写入\n- partial\n`
      });
    }
    if (Object.hasOwn(updates, 'content') && updates.content.includes('Session ended at')) {
      return { success: false, error_code: 'document_update_failed' };
    }
    return originalUpdate(documentPath, updates);
  };

  const result = await backend.recordSession({
    session: {
      session_id: 'session-update-mid-write-rollback',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [{ document_type: 'task', logical_id: 'mid-write-rollback-task' }],
    auto_archive_completed: false
  });

  assertLocalResult(result);
  assert.equal(result.status, 'operation_failed');
  assert.equal(result.error_code, 'document_update_failed');
  assert.equal(await readFile(created.document.path, 'utf8'), before);
  await assert.rejects(
    readFile(path.join(root, 'docs', '.docs-metadata', 'checkpoints.json'), 'utf8'),
    { code: 'ENOENT' }
  );
});

test('fails closed for an unknown local logical reference without scanning or rewriting other Markdown', async () => {
  const root = await retainedFixture('unknown-session-ref');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const existing = await backend.create({
    document_type: 'task',
    title: 'Known task',
    content: '# Known task\n\n## 基本信息\n- 状态: 待开始\n\n## 进展记录\n- 2026-08-10: ready\n'
  });
  const before = await readFile(existing.document.path, 'utf8');

  const result = await backend.recordSession({
    session: {
      session_id: 'unknown-session-ref',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [{ document_type: 'task', logical_id: 'not-present' }],
    auto_archive_completed: true
  });

  assertLocalResult(result);
  assert.equal(result.status, 'not_found');
  assert.equal(result.error_code, 'session_reference_not_found');
  assert.equal(await readFile(existing.document.path, 'utf8'), before);
});

test('fails closed before a session rewrite when a matching local filename lacks a controlled progress record', async () => {
  const root = await retainedFixture('unmanaged-session-reference');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const created = await backend.create({
    document_type: 'task',
    title: 'Unmanaged session reference',
    content: '# Arbitrary Markdown\n\nThis is not a runtime-managed progress document.\n'
  });
  const before = await readFile(created.document.path, 'utf8');

  const result = await backend.recordSession({
    session: {
      session_id: 'unmanaged-session-reference',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [{ document_type: 'task', logical_id: 'unmanaged-session-reference' }],
    auto_archive_completed: true
  });

  assertLocalResult(result);
  assert.equal(result.status, 'invalid_request');
  assert.equal(result.error_code, 'session_reference_unmanaged');
  assert.equal(await readFile(created.document.path, 'utf8'), before);
  await assert.rejects(
    readFile(path.join(root, 'docs', '.docs-metadata', 'checkpoints.json'), 'utf8'),
    { code: 'ENOENT' }
  );
});

test('records a generated legacy bug template through the controlled local session path', async () => {
  const root = await retainedFixture('legacy-bug-session-reference');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const created = await backend.create({
    document_type: 'bug',
    title: 'Legacy bug session reference'
  });

  const result = await backend.recordSession({
    session: {
      session_id: 'legacy-bug-session-reference',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/runtime-fixture'
    },
    document_refs: [{ document_type: 'bug', logical_id: 'legacy-bug-session-reference' }],
    auto_archive_completed: false
  });

  assertLocalResult(result);
  assert.equal(result.status, 'recorded');
  const content = await readFile(created.document.path, 'utf8');
  assert.match(content, /## 进展记录/u);
  assert.match(content, /Session ended at 2026-08-10T00:00:00Z/u);
});

test('rejects path or body carriers in local record-session requests', async () => {
  const root = await retainedFixture('session-request-boundary');
  const backend = new LocalDocsBackend({ projectRoot: root, projectId: 'fixture/local-docs' });
  const existing = await backend.create({
    document_type: 'task',
    title: 'Boundary task',
    content: '# Boundary task\n\n## 基本信息\n- 状态: 待开始\n\n## 进展记录\n- 2026-08-10: ready\n'
  });
  const before = await readFile(existing.document.path, 'utf8');
  const session = {
    session_id: 'session-request-boundary',
    ended_at: '2026-08-10T00:00:00Z',
    branch: 'feat/runtime-fixture'
  };

  const referencePath = await backend.recordSession({
    session,
    document_refs: [{
      document_type: 'task',
      logical_id: 'boundary-task',
      path: existing.document.path
    }],
    auto_archive_completed: false
  });
  assertLocalResult(referencePath);
  assert.equal(referencePath.status, 'invalid_request');
  assert.equal(referencePath.error_code, 'session_reference_invalid');

  const topLevelBody = await backend.recordSession({
    session,
    document_refs: [{ document_type: 'task', logical_id: 'boundary-task' }],
    auto_archive_completed: false,
    body: '# injected body'
  });
  assertLocalResult(topLevelBody);
  assert.equal(topLevelBody.status, 'invalid_request');
  assert.equal(topLevelBody.error_code, 'session_request_invalid');
  assert.equal(await readFile(existing.document.path, 'utf8'), before);
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
