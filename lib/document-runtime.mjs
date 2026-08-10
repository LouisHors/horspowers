import { LocalDocsBackend } from './document-backends/local-docs-backend.mjs';
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

function isAbsoluteCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(cwd);
}

function projectIdFrom(context) {
  return context?.project?.project_id ?? null;
}

function resolution(status, backend, projectId, errorCode = null) {
  return {
    status,
    backend,
    project_id: projectId,
    ...(errorCode ? { error_code: errorCode } : {})
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
      const status = typeof context.status === 'string' ? context.status : 'context_unavailable';
      return {
        result: resolution(status, 'disabled', projectId, context.error_code ?? status),
        context
      };
    }

    const documentation = context.documentation;
    if (!documentation || documentation.enabled !== true || documentation.backend === 'disabled') {
      return {
        result: resolution('documentation_disabled', 'disabled', projectId, 'documentation_disabled'),
        context
      };
    }
    if (documentation.backend === 'local') {
      return { result: resolution('ready', 'local', projectId), context };
    }
    if (documentation.backend === 'wiki') {
      return {
        result: resolution('wiki_backend_not_implemented', 'wiki', projectId, 'wiki_backend_not_implemented'),
        context
      };
    }
    return {
      result: resolution('documentation_backend_unavailable', 'disabled', projectId, 'documentation_backend_unavailable'),
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
    if (selected.result.backend !== 'local') return selected.result;

    const projectRoot = selected.context?.project?.root;
    if (!isAbsoluteCwd(projectRoot)) {
      return resolution('context_unavailable', 'disabled', selected.result.project_id, 'project_root_unavailable');
    }

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

  async run(input = {}) {
    return this.execute(input);
  }
}

export async function resolveDocumentRuntime(cwd, options = {}) {
  return DocumentRuntime.resolve(cwd, options);
}
