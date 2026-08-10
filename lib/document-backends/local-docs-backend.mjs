import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { UnifiedDocsManager } = require('../docs-core.js');

const ACTIVE_DOCUMENT_TYPES = new Set(['task', 'bug', 'context']);
const CREATE_DOCUMENT_TYPES = new Set(['design', 'plan', ...ACTIVE_DOCUMENT_TYPES]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    const updated = this.manager.updateDocument(documentPath, request.updates);
    if (!updated.success) return this.failure(updated);
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

  async recordSession(request = {}) {
    if (!isPlainObject(request) || !isPlainObject(request.session)) {
      return this.result('invalid_request', { error_code: 'session_required' });
    }
    const session = request.session;
    if (typeof session.session_id !== 'string' || session.session_id.length === 0 ||
        typeof session.ended_at !== 'string' || typeof session.branch !== 'string') {
      return this.result('invalid_request', { error_code: 'session_invalid' });
    }
    if (request.document_refs !== undefined && !Array.isArray(request.document_refs)) {
      return this.result('invalid_request', { error_code: 'document_refs_invalid' });
    }
    if (request.auto_archive_completed !== undefined && typeof request.auto_archive_completed !== 'boolean') {
      return this.result('invalid_request', { error_code: 'auto_archive_completed_invalid' });
    }

    const checkpoint = this.manager.setCheckpoint('last-session', {
      sessionId: session.session_id,
      endedAt: session.ended_at,
      gitBranch: session.branch,
      documentRefs: request.document_refs ?? [],
      autoArchiveCompleted: request.auto_archive_completed === true
    });
    if (!checkpoint?.success) return this.failure(checkpoint, 'session_record_failed');
    const archiveResult = request.auto_archive_completed === true
      ? this.manager.archiveCompleted()
      : null;
    if (archiveResult && !archiveResult.success) return this.failure(archiveResult, 'session_archive_failed');
    return this.result('recorded', {
      session: {
        session_id: session.session_id,
        ended_at: session.ended_at,
        branch: session.branch
      },
      ...(archiveResult ? { archived_count: archiveResult.count } : {})
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
