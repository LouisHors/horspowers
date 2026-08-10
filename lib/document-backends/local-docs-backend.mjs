import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { UnifiedDocsManager } = require('../docs-core.js');

const ACTIVE_DOCUMENT_TYPES = new Set(['task', 'bug', 'context']);
const CREATE_DOCUMENT_TYPES = new Set(['design', 'plan', ...ACTIVE_DOCUMENT_TYPES]);
const SESSION_REFERENCE_DOCUMENT_TYPES = new Set(['task', 'bug']);
const MAX_SESSION_REFERENCES = 64;
const ACTIVE_SESSION_FILENAME = /^\d{4}-\d{2}-\d{2}-(task|bug)-(.+)\.md$/u;
const COMPLETED_DOCUMENT_STATUSES = new Set(['已完成', '已修复', 'completed', 'fixed']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowedKeys, requiredKeys = allowedKeys) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set(allowedKeys);
  const keys = Object.keys(value);
  return keys.every(key => allowed.has(key)) && requiredKeys.every(key => Object.hasOwn(value, key));
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isSafeSessionText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001F\u007F]/u.test(value);
}

/**
 * Local docs predate the external Wiki logical-id grammar and can contain a
 * generated Chinese slug.  Keep that legacy naming compatible while refusing
 * separators, control characters, and other filesystem-significant input.
 */
function isLocalLogicalId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u001F\u007F\\/<>:"|?*]/u.test(value);
}

function currentDocumentStatus(content) {
  if (typeof content !== 'string') return null;
  const heading = /^## 基本信息[ \t]*\r?$/mu.exec(content);
  if (!heading) return null;

  let sectionStart = heading.index + heading[0].length;
  if (content[sectionStart] === '\r') sectionStart += 1;
  if (content[sectionStart] === '\n') sectionStart += 1;
  const nextHeading = content.indexOf('\n## ', sectionStart);
  const basicInfo = content.slice(sectionStart, nextHeading === -1 ? content.length : nextHeading);
  const status = /(?:^|\n)[ \t]*-[ \t]*状态[：:][ \t]*([^\r\n]+)/u.exec(basicInfo);
  return status?.[1].trim().toLowerCase() ?? null;
}

function isCompletedDocument(content) {
  const status = currentDocumentStatus(content);
  return status !== null && COMPLETED_DOCUMENT_STATUSES.has(status);
}

function countHeading(content, heading) {
  const normalized = content.replace(/\r\n?/gu, '\n');
  return normalized.split('\n').filter(line => line === heading).length;
}

function isControlledSessionDocument(documentType, content) {
  if (typeof content !== 'string') return false;
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (!/^# [^\n]+$/mu.test(normalized) || countHeading(normalized, '## 基本信息') !== 1) {
    return false;
  }
  if (countHeading(normalized, '## 进展记录') === 1) return true;

  // The legacy Bug template has no progress section, but its fixed heading
  // set is still sufficient to prove that it is a managed active document.
  if (documentType !== 'bug' || !/^# Bug报告: [^\n]+$/mu.test(normalized)) return false;
  return [
    '## 问题描述',
    '## 复现步骤',
    '## 期望结果',
    '## 实际结果',
    '## 分析过程',
    '## 解决方案',
    '## 验证结果'
  ].every(heading => countHeading(normalized, heading) === 1);
}

function appendProgress(content, progress) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const progressLine = `- ${new Date().toISOString().slice(0, 10)}: ${progress}`;
  const progressHeading = `## 进展记录${newline}`;
  const start = content.indexOf(progressHeading);
  if (start === -1) {
    return `${content}${content.endsWith(newline) ? newline : `${newline}${newline}`}${progressHeading}${progressLine}${newline}`;
  }

  const nextHeading = content.indexOf(`${newline}## `, start + progressHeading.length);
  if (nextHeading === -1) {
    return `${content}${content.endsWith(newline) ? '' : newline}${progressLine}${newline}`;
  }
  return `${content.slice(0, nextHeading)}${newline}${progressLine}${newline}${content.slice(nextHeading)}`;
}

function countOccurrences(content, needle) {
  if (typeof content !== 'string' || needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function documentFromCore(document) {
  return {
    path: document.path,
    ...(document.relativePath ? { relative_path: document.relativePath } : {}),
    ...(document.type ? { document_type: document.type } : {}),
    ...(typeof document.content === 'string' ? { content: document.content } : {})
  };
}

function failureStatus(errorCode) {
  if (typeof errorCode === 'string' && (
    errorCode === 'document_path_invalid' ||
    errorCode === 'document_path_outside_docs' ||
    errorCode === 'document_path_outside_active' ||
    errorCode === 'document_path_outside_archive' ||
    errorCode === 'document_update_invalid' ||
    errorCode === 'document_update_empty'
  )) return 'invalid_request';
  if (errorCode === 'document_not_found') return 'not_found';
  if (errorCode === 'document_already_exists') return 'conflict';
  return 'operation_failed';
}

/**
 * Adapter for Horspowers' existing project-local docs manager.  It keeps the
 * legacy filenames and directories intact while exposing the common runtime
 * result envelope used by local and future Wiki backends.
 */
export class LocalDocsBackend {
  constructor({ projectRoot, projectId = null, manager = null, DocsManager = UnifiedDocsManager } = {}) {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
      throw new TypeError('projectRoot must be an absolute path');
    }
    this.projectRoot = projectRoot;
    this.projectId = projectId;
    this.manager = manager ?? new DocsManager(projectRoot);
  }

  result(status, fields = {}) {
    return {
      status,
      backend: 'local',
      project_id: this.projectId,
      ...fields
    };
  }

  failure(coreResult, fallbackCode = 'local_docs_operation_failed') {
    const errorCode = coreResult?.error_code ?? fallbackCode;
    return this.result(failureStatus(errorCode), { error_code: errorCode });
  }

  async get(request = {}) {
    const documentPath = request?.path ?? request?.document_path;
    const document = this.manager.getDocument(documentPath);
    if (!document.success) return this.failure(document);
    return this.result('ok', { document: documentFromCore(document) });
  }

  async search(request = {}) {
    if (!isPlainObject(request) || typeof request.query !== 'string') {
      return this.result('invalid_request', { error_code: 'search_query_required' });
    }
    const results = this.manager.search(request.query, isPlainObject(request.options) ? request.options : {});
    return this.result('ok', {
      documents: results.map(result => ({
        path: result.fullpath,
        relative_path: result.file,
        document_type: result.type,
        matches: result.matches
      }))
    });
  }

  async create(request = {}) {
    if (!isPlainObject(request)) return this.result('invalid_request', { error_code: 'create_request_required' });
    const documentType = request.document_type ?? request.type;
    if (!CREATE_DOCUMENT_TYPES.has(documentType)) {
      return this.result('invalid_request', { error_code: 'unsupported_document_type' });
    }
    if (typeof request.title !== 'string' || request.title.trim() === '') {
      return this.result('invalid_request', { error_code: 'document_title_required' });
    }
    if (request.content !== undefined && request.content !== null && typeof request.content !== 'string') {
      return this.result('invalid_request', { error_code: 'document_content_invalid' });
    }

    const content = request.content ?? null;
    let created;
    if (documentType === 'design') {
      created = this.manager.createDesignDocument(request.title, content);
    } else if (documentType === 'plan') {
      created = this.manager.createPlanDocument(request.title, content);
    } else {
      const relatedDocs = isPlainObject(request.related_docs)
        ? request.related_docs
        : isPlainObject(request.relatedDocs) ? request.relatedDocs : {};
      created = this.manager.createActiveDocument(documentType, request.title, content, relatedDocs);
    }
    if (!created.success) return this.result('conflict', { error_code: 'document_already_exists' });

    const document = this.manager.getDocument(created.path);
    if (!document.success) return this.failure(document);
    return this.result('created', { document: documentFromCore(document) });
  }

  async update(request = {}) {
    if (!isPlainObject(request) || !isPlainObject(request.updates)) {
      return this.result('invalid_request', { error_code: 'document_update_invalid' });
    }
    const documentPath = request.path ?? request.document_path;
    let expectedProgressOccurrences = null;
    if (typeof request.updates.progress === 'string' && typeof this.manager.getDocument === 'function') {
      const before = this.manager.getDocument(documentPath);
      if (!before.success) return this.failure(before);
      const baseContent = Object.hasOwn(request.updates, 'content') ? request.updates.content : before.content;
      expectedProgressOccurrences = countOccurrences(baseContent, request.updates.progress);
    }
    let updated = this.manager.updateDocument(documentPath, request.updates);
    if (!updated.success) return this.failure(updated);

    // docs-core preserves the old local markdown semantics, including a
    // legacy edge case where an existing progress section is not appended.
    // The adapter promises that a supplied progress update is persisted.
    if (typeof request.updates.progress === 'string' && typeof updated.content === 'string' &&
        (expectedProgressOccurrences === null
          ? !updated.content.includes(request.updates.progress)
          : countOccurrences(updated.content, request.updates.progress) <= expectedProgressOccurrences)) {
      updated = this.manager.updateDocument(updated.path, {
        content: appendProgress(updated.content, request.updates.progress)
      });
      if (!updated.success) return this.failure(updated);
    }
    return this.result('updated', { document: documentFromCore(updated) });
  }

  async archive(request = {}) {
    const documentPath = request?.path ?? request?.document_path;
    const archived = this.manager.archiveDocument(documentPath);
    if (!archived.success) return this.failure(archived);
    const document = this.manager.getDocument(archived.archivedPath);
    if (!document.success) return this.failure(document);
    return this.result('archived', { document: documentFromCore(document) });
  }

  async restore(request = {}) {
    const documentPath = request?.path ?? request?.document_path;
    const restored = this.manager.restoreDocument(documentPath);
    if (!restored.success) return this.failure(restored);
    const document = this.manager.getDocument(restored.restoredPath ?? restored.path);
    if (!document.success) return this.failure(document);
    return this.result('restored', { document: documentFromCore(document) });
  }

  resolveSessionReferences(references) {
    if (references.length === 0) return { ok: true, references: [] };
    if (typeof this.manager?.getTrustedDocumentDirectory !== 'function' ||
        typeof this.manager?.getDocument !== 'function' || typeof this.manager.activeDir !== 'string') {
      return {
        ok: false,
        result: this.result('operation_failed', { error_code: 'session_reference_resolution_failed' })
      };
    }

    const activeDirectory = this.manager.getTrustedDocumentDirectory(this.manager.activeDir);
    if (!activeDirectory?.success) {
      return { ok: false, result: this.failure(activeDirectory, 'session_reference_resolution_failed') };
    }

    let entries;
    try {
      entries = readdirSync(activeDirectory.path, { withFileTypes: true });
    } catch {
      return {
        ok: false,
        result: this.result('operation_failed', { error_code: 'session_reference_resolution_failed' })
      };
    }

    const resolved = [];
    for (const reference of references) {
      const candidates = entries.filter((entry) => {
        const match = ACTIVE_SESSION_FILENAME.exec(entry.name);
        return entry.isFile() && match !== null &&
          match[1] === reference.document_type && match[2] === reference.logical_id;
      });
      if (candidates.length === 0) {
        return {
          ok: false,
          result: this.result('not_found', { error_code: 'session_reference_not_found' })
        };
      }
      if (candidates.length > 1) {
        return {
          ok: false,
          result: this.result('conflict', { error_code: 'session_reference_ambiguous' })
        };
      }

      const documentPath = path.resolve(activeDirectory.path, candidates[0].name);
      if (!isPathWithin(activeDirectory.path, documentPath)) {
        return {
          ok: false,
          result: this.result('invalid_request', { error_code: 'session_reference_not_active' })
        };
      }
      const document = this.manager.getDocument(documentPath);
      if (!document?.success) {
        if (document?.error_code === 'document_not_found') {
          return {
            ok: false,
            result: this.result('not_found', { error_code: 'session_reference_not_found' })
          };
        }
        return { ok: false, result: this.failure(document, 'session_reference_resolution_failed') };
      }
      if (!isPathWithin(activeDirectory.path, document.path) || document.type !== reference.document_type) {
        return {
          ok: false,
          result: this.result('invalid_request', { error_code: 'session_reference_not_active' })
        };
      }
      if (!isControlledSessionDocument(reference.document_type, document.content)) {
        return {
          ok: false,
          result: this.result('invalid_request', { error_code: 'session_reference_unmanaged' })
        };
      }
      resolved.push({
        ...reference,
        path: document.path,
        content: document.content,
        completed: isCompletedDocument(document.content)
      });
    }
    return { ok: true, references: resolved };
  }

  rollbackSessionChanges(changes) {
    let rolledBack = true;
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index];
      let documentPath = change.reference.path;
      if (change.archivedPath) {
        if (typeof this.manager.restoreDocument !== 'function') {
          rolledBack = false;
          continue;
        }
        const restored = this.manager.restoreDocument(change.archivedPath);
        if (!restored?.success) {
          rolledBack = false;
          continue;
        }
        documentPath = restored.restoredPath ?? restored.path;
      }
      if (change.updateAttempted) {
        const restored = this.manager.updateDocument(documentPath, { content: change.reference.content });
        if (!restored?.success) rolledBack = false;
      }
    }
    return rolledBack;
  }

  rollbackFailure(changes, failure) {
    if (!this.rollbackSessionChanges(changes)) {
      return this.result('operation_failed', { error_code: 'session_rollback_failed' });
    }
    return failure();
  }

  async recordSession(request = {}) {
    if (!isPlainObject(request) || !isPlainObject(request.session)) {
      return this.result('invalid_request', { error_code: 'session_required' });
    }
    if (!hasOnlyKeys(request, ['session', 'document_refs', 'auto_archive_completed'], ['session'])) {
      return this.result('invalid_request', { error_code: 'session_request_invalid' });
    }
    const session = request.session;
    if (!hasOnlyKeys(session, ['session_id', 'ended_at', 'branch']) ||
        !isSafeSessionText(session.session_id) || !isSafeSessionText(session.ended_at) ||
        !isSafeSessionText(session.branch)) {
      return this.result('invalid_request', { error_code: 'session_invalid' });
    }
    if (request.document_refs !== undefined && !Array.isArray(request.document_refs)) {
      return this.result('invalid_request', { error_code: 'document_refs_invalid' });
    }
    if (request.auto_archive_completed !== undefined && typeof request.auto_archive_completed !== 'boolean') {
      return this.result('invalid_request', { error_code: 'auto_archive_completed_invalid' });
    }

    const references = request.document_refs ?? [];
    if (references.length > MAX_SESSION_REFERENCES) {
      return this.result('invalid_request', { error_code: 'document_refs_invalid' });
    }
    const seenReferences = new Set();
    for (const reference of references) {
      if (!hasOnlyKeys(reference, ['document_type', 'logical_id']) ||
          !SESSION_REFERENCE_DOCUMENT_TYPES.has(reference.document_type) ||
          !isLocalLogicalId(reference.logical_id)) {
        return this.result('invalid_request', { error_code: 'session_reference_invalid' });
      }
      const key = `${reference.document_type}:${reference.logical_id}`;
      if (seenReferences.has(key)) {
        return this.result('invalid_request', { error_code: 'session_reference_duplicate' });
      }
      seenReferences.add(key);
    }

    // Resolve every logical reference before persisting metadata or mutating a
    // document.  This prevents an unknown later reference from producing a
    // partial session update.
    const resolved = this.resolveSessionReferences(references);
    if (!resolved.ok) return resolved.result;

    const changes = [];
    for (const reference of resolved.references) {
      const change = { reference, updateAttempted: false, archivedPath: null };
      changes.push(change);
      change.updateAttempted = true;
      const updated = await this.update({
        path: reference.path,
        updates: { progress: `Session ended at ${session.ended_at}` }
      });
      if (updated.status !== 'updated') {
        return this.rollbackFailure(changes, () => this.result(updated.status, {
          error_code: updated.error_code ?? 'session_update_failed'
        }));
      }
    }

    let archivedCount = 0;
    if (request.auto_archive_completed === true) {
      for (const change of changes) {
        if (!change.reference.completed) continue;
        const archived = this.manager.archiveDocument(change.reference.path);
        if (!archived?.success || typeof archived.archivedPath !== 'string') {
          return this.rollbackFailure(changes, () => this.failure(archived, 'session_archive_failed'));
        }
        change.archivedPath = archived.archivedPath;
        archivedCount += 1;
      }
    }

    const checkpoint = this.manager.setCheckpoint('last-session', {
      sessionId: session.session_id,
      endedAt: session.ended_at,
      gitBranch: session.branch,
      documentRefs: references,
      autoArchiveCompleted: request.auto_archive_completed === true
    });
    if (!checkpoint?.success) {
      return this.rollbackFailure(changes, () => this.failure(checkpoint, 'session_record_failed'));
    }

    return this.result('recorded', {
      session: {
        session_id: session.session_id,
        ended_at: session.ended_at,
        branch: session.branch
      },
      ...(request.auto_archive_completed === true ? { archived_count: archivedCount } : {})
    });
  }

  async execute(action, request = {}) {
    switch (action) {
      case 'get': return this.get(request);
      case 'search': return this.search(request);
      case 'create': return this.create(request);
      case 'update': return this.update(request);
      case 'archive': return this.archive(request);
      case 'restore': return this.restore(request);
      case 'record-session': return this.recordSession(request);
      default: return this.result('invalid_request', { error_code: 'action_not_supported' });
    }
  }
}
