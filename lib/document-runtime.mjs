import { LocalDocsBackend } from './document-backends/local-docs-backend.mjs';
import { InboxSubmitter } from './inbox-submitter.mjs';
import { resolveProjectContext as resolveProjectContextDefault } from './project-context.mjs';

const ACTIONS = new Set([
  'resolve',
  'get',
  'search',
  'create',
  'update',
  'archive',
  'restore',
  'config-change',
  'record-session'
]);

/**
 * Stable catalog for the built-in DocumentRuntime result envelope.  Backends
 * and the CLI return only these status values in production; callers must
 * treat an unknown non-ready value as unavailable and never fall back to a
 * project-local document write.
 */
export const DOCUMENT_RUNTIME_RESULT_STATUSES = Object.freeze([
  'ready',
  'ok',
  'created',
  'updated',
  'archived',
  'restored',
  'recorded',
  'confirmation_required',
  'submitted_pending_review',
  'partially_submitted',
  'invalid_request',
  'context_unavailable',
  'not_a_project',
  'unregistered_no_remote',
  'ambiguous_company_remote',
  'wiki_unavailable',
  'unregistered_company_project',
  'registry_invalid',
  'project_config_invalid',
  'project_config_incompatible',
  'local_config_unavailable',
  'documentation_disabled',
  'documentation_backend_unavailable',
  'local_backend_unavailable',
  'wiki_backend_unavailable',
  'not_found',
  'conflict',
  'operation_failed',
  'document_not_found',
  'document_conflict',
  'manifest_invalid',
  'manifest_incompatible',
  'manifest_content_mismatch',
  'config_manifest_mismatch',
  'wiki_search_invalid',
  'safe_document_required',
  'submission_safety_blocked',
  'raw_source_detected',
  'source_scan_incomplete',
  'submission_failed',
  'runtime_unavailable'
]);

const DOCUMENT_RUNTIME_RESULT_STATUS_SET = new Set(DOCUMENT_RUNTIME_RESULT_STATUSES);

function isAbsoluteCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(cwd);
}

function projectIdFrom(context) {
  return context?.project?.project_id ?? null;
}

function resolutionMetadata(context) {
  if (!context || typeof context !== 'object') return {};
  return {
    identity_status: context.project?.identity_status ?? 'none',
    config_source: context.config?.source ?? 'none',
    config_status: typeof context.config_status === 'string' ? context.config_status : 'unavailable',
    documentation_enabled: context.documentation?.enabled === true
  };
}

function resolution(status, backend, projectId, errorCode = null, context = null) {
  return {
    status,
    backend,
    project_id: projectId,
    ...(errorCode ? { error_code: errorCode } : {}),
    ...resolutionMetadata(context)
  };
}

/**
 * Selects the configured document backend without letting selection itself
 * create project-local docs.  Mutating/local operations instantiate their
 * backend only after a successful local resolution.
 */
export class DocumentRuntime {
  constructor(options = {}) {
    this.resolveProjectContext = options.resolveProjectContext ??
      options.resolveContext ?? resolveProjectContextDefault;
    this.LocalDocsBackend = options.LocalDocsBackend ??
      options.localDocsBackend ?? LocalDocsBackend;
    this.WikiDocsBackend = options.WikiDocsBackend ?? options.wikiDocsBackend ?? null;
    this.InboxSubmitter = options.InboxSubmitter ?? options.inboxSubmitter ?? InboxSubmitter;
  }

  static async resolve(cwd, options = {}) {
    return new DocumentRuntime(options).resolve(cwd);
  }

  static async execute(input, options = {}) {
    return new DocumentRuntime(options).execute(input);
  }

  async select(cwd) {
    if (!isAbsoluteCwd(cwd)) {
      return {
        result: resolution('invalid_request', 'disabled', null, 'cwd_must_be_absolute'),
        context: null
      };
    }

    let context;
    try {
      context = await this.resolveProjectContext({ cwd });
    } catch {
      return {
        result: resolution('context_unavailable', 'disabled', null, 'context_unavailable'),
        context: null
      };
    }

    const projectId = projectIdFrom(context);
    if (!context || typeof context !== 'object') {
      return {
        result: resolution('context_unavailable', 'disabled', projectId, 'context_unavailable'),
        context: null
      };
    }
    if (context.status !== 'ready') {
      const status = typeof context.status === 'string' &&
        DOCUMENT_RUNTIME_RESULT_STATUS_SET.has(context.status)
        ? context.status
        : 'context_unavailable';
      const errorCode = status === context.status
        ? context.error_code ?? status
        : 'context_status_unrecognized';
      return {
        result: resolution(status, 'disabled', projectId, errorCode, context),
        context
      };
    }

    const documentation = context.documentation;
    if (!documentation || documentation.enabled !== true || documentation.backend === 'disabled') {
      return {
        result: resolution('documentation_disabled', 'disabled', projectId, 'documentation_disabled', context),
        context
      };
    }
    if (documentation.backend === 'local') {
      return { result: resolution('ready', 'local', projectId, null, context), context };
    }
    if (documentation.backend === 'wiki') {
      return { result: resolution('ready', 'wiki', projectId, null, context), context };
    }
    return {
      result: resolution('documentation_backend_unavailable', 'disabled', projectId, 'documentation_backend_unavailable', context),
      context
    };
  }

  async resolve(cwd) {
    const selected = await this.select(cwd);
    return selected.result;
  }

  async execute({ cwd, action, request = {}, confirmed = false } = {}) {
    if (!ACTIONS.has(action)) {
      return resolution('invalid_request', 'disabled', null, 'unknown_action');
    }

    const selected = await this.select(cwd);
    if (action === 'resolve') return selected.result;
    if (selected.result.status !== 'ready') return selected.result;

    const projectRoot = selected.context?.project?.root;
    if (!isAbsoluteCwd(projectRoot)) {
      return resolution('context_unavailable', 'disabled', selected.result.project_id, 'project_root_unavailable');
    }

    if (selected.result.backend === 'local') {
      let backend;
      try {
        backend = new this.LocalDocsBackend({
          projectRoot,
          projectId: selected.result.project_id
        });
      } catch {
        return resolution('local_backend_unavailable', 'local', selected.result.project_id, 'local_backend_unavailable');
      }

      try {
        const outcome = await backend.execute(action, request, { confirmed });
        return {
          ...outcome,
          backend: outcome?.backend ?? 'local',
          project_id: outcome?.project_id ?? selected.result.project_id
        };
      } catch {
        return resolution('local_backend_unavailable', 'local', selected.result.project_id, 'local_backend_operation_failed');
      }
    }

    if (selected.result.backend !== 'wiki') return selected.result;

    const wiki = selected.context?.wiki;
    const config = selected.context?.config?.value;
    const inbox = wiki?.host_config?.wiki?.inbox;
    if (!wiki || typeof wiki.config_uri !== 'string' || !wiki.qmd_client || !config ||
        !inbox || typeof inbox.command !== 'string') {
      return resolution('wiki_backend_unavailable', 'wiki', selected.result.project_id, 'wiki_runtime_metadata_unavailable');
    }

    try {
      const Backend = this.WikiDocsBackend ?? (await import('./document-backends/wiki-docs-backend.mjs')).WikiDocsBackend;
      const submitter = new this.InboxSubmitter({
        command: inbox.command,
        timeoutMs: inbox.timeout_ms,
        maxPayloadBytes: inbox.max_payload_bytes
      });
      const backend = new Backend({
        projectRoot,
        projectId: selected.result.project_id,
        config,
        configUri: wiki.config_uri,
        hostConfig: wiki.host_config,
        qmdClient: wiki.qmd_client,
        submitter
      });
      const outcome = await backend.execute(action, request, { confirmed });
      return {
        ...outcome,
        backend: outcome?.backend ?? 'wiki',
        project_id: outcome?.project_id ?? selected.result.project_id
      };
    } catch {
      return resolution('wiki_backend_unavailable', 'wiki', selected.result.project_id, 'wiki_backend_operation_failed');
    }
  }

  async run(input = {}) {
    return this.execute(input);
  }
}

export async function resolveDocumentRuntime(cwd, options = {}) {
  return DocumentRuntime.resolve(cwd, options);
}
