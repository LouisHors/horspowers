import path from 'node:path';

const DEFERRED_OPERATIONS = new Set([
  'document_change_preview',
  'document_change_submit',
  'document_transition_preview',
  'document_transition_submit',
  'project_bootstrap_preview',
  'project_bootstrap_submit'
]);

function descriptor(method, {
  readOnly = true,
  allowed = [],
  required = [],
  exactlyOne = [],
  exposed = true,
  deferred = false
} = {}) {
  return Object.freeze({
    method, readOnly, allowed: Object.freeze(allowed), required: Object.freeze(required),
    exactlyOne: Object.freeze(exactlyOne), exposed, deferred
  });
}

export const HPS_OPERATION_DEFINITIONS = Object.freeze({
  task_prepare: descriptor('taskPrepare', { allowed: ['message', 'active_route', 'host', 'query', 'known_entry_files', 'wiki_root'] }),
  project_snapshot: descriptor('projectSnapshot', { allowed: ['scope_id'] }),
  project_context: descriptor('projectContext', { allowed: ['scope_id'], required: ['scope_id'] }),
  git_preflight: descriptor('gitPreflight', { allowed: ['scope_id'] }),
  diff_snapshot: descriptor('diffSnapshot', { allowed: ['scope_id'] }),
  document_resolve: descriptor('documentRead', { allowed: ['scope_id'] }),
  document_search: descriptor('documentRead', { allowed: ['scope_id', 'query', 'intent'], required: ['scope_id', 'query', 'intent'] }),
  document_get: descriptor('documentRead', { allowed: ['scope_id', 'logical_id', 'document_ref'], required: ['scope_id'], exactlyOne: ['logical_id', 'document_ref'] }),
  document_manifest: descriptor('documentManifest', { allowed: ['scope_id'], required: ['scope_id'] }),
  document_verify: descriptor('documentVerify', { allowed: ['scope_id', 'logical_id', 'document_ref'], required: ['scope_id'], exactlyOne: ['logical_id', 'document_ref'] }),
  context_collect: descriptor('contextCollect', { allowed: ['scope_id', 'query'], required: ['scope_id'] }),
  verification_run: descriptor('verificationRun', { allowed: ['scope_id', 'profile'], required: ['scope_id', 'profile'] }),
  session_prepare: descriptor('sessionPrepare', { readOnly: false, allowed: ['scope_id', 'request_id', 'value'], required: ['scope_id', 'request_id'] }),
  session_record: descriptor('sessionRecord', { readOnly: false, allowed: ['scope_id', 'request_id', 'idempotency_key', 'references'], required: ['scope_id', 'request_id', 'idempotency_key'] }),
  checkpoint_get: descriptor('checkpointGet', { allowed: ['scope_id', 'checkpoint_id'], required: ['scope_id', 'checkpoint_id'] }),
  checkpoint_put: descriptor('checkpointPut', { readOnly: false, allowed: ['scope_id', 'checkpoint_id', 'value'], required: ['scope_id', 'checkpoint_id'] }),
  commit_preview: descriptor('commitPreview', { allowed: ['scope_id'], required: ['scope_id'] }),
  merge_preview: descriptor('mergePreview', { allowed: ['scope_id', 'target_branch'], required: ['scope_id', 'target_branch'] }),
  runtime_doctor: descriptor('runtimeDoctor'),
  document_change_preview: descriptor(null, { exposed: false, deferred: true }),
  document_change_submit: descriptor(null, { exposed: false, deferred: true }),
  document_transition_preview: descriptor(null, { exposed: false, deferred: true }),
  document_transition_submit: descriptor(null, { exposed: false, deferred: true }),
  project_bootstrap_preview: descriptor(null, { exposed: false, deferred: true }),
  project_bootstrap_submit: descriptor(null, { exposed: false, deferred: true })
});

export const HPS_OPERATION_NAMES = Object.freeze(Object.keys(HPS_OPERATION_DEFINITIONS));

export class HpsError extends Error {
  constructor(code, {
    category = 'runtime',
    retryable = false,
    requiredAction = null
  } = {}) {
    super(code);
    this.name = 'HpsError';
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.requiredAction = requiredAction;
  }
}

export const HPS_ERROR_CATALOG = Object.freeze({
  empty_input: Object.freeze({ category: 'validation', retryable: false, requiredAction: 'send_one_json_request' }),
  input_too_large: Object.freeze({ category: 'validation', retryable: false, requiredAction: 'reduce_request_size' }),
  argv_not_supported: Object.freeze({ category: 'validation', retryable: false, requiredAction: 'use_json_stdin' }),
  invalid_command: Object.freeze({ category: 'validation', retryable: false, requiredAction: 'use_hps_call' }),
  operation_not_found: Object.freeze({ category: 'routing', retryable: false, requiredAction: 'use_supported_operation' }),
  operation_unavailable: Object.freeze({ category: 'routing', retryable: false, requiredAction: 'use_supported_operation' }),
  invalid_request: Object.freeze({ category: 'validation', retryable: false, requiredAction: 'fix_input' }),
  scope_expired: Object.freeze({ category: 'conflict', retryable: true, requiredAction: 'run_task_prepare' }),
  cancelled: Object.freeze({ category: 'runtime', retryable: true, requiredAction: 'retry_if_safe' }),
  timeout: Object.freeze({ category: 'runtime', retryable: true, requiredAction: 'retry_if_safe' }),
  overloaded: Object.freeze({ category: 'transport', retryable: true, requiredAction: 'retry_later' }),
  profile_not_allowlisted: Object.freeze({ category: 'validation', retryable: false, requiredAction: 'choose_allowlisted_profile' }),
  session_conflict: Object.freeze({ category: 'conflict', retryable: false, requiredAction: 'use_new_idempotency_key' }),
  unsafe_session_input: Object.freeze({ category: 'validation', retryable: false, requiredAction: 'fix_input' }),
  runtime_error: Object.freeze({ category: 'runtime', retryable: true, requiredAction: 'inspect_metrics' })
});

function catalogError(code) {
  const safeCode = Object.hasOwn(HPS_ERROR_CATALOG, code) ? code : 'runtime_error';
  return new HpsError(safeCode, HPS_ERROR_CATALOG[safeCode]);
}

export function catalogErrorCode(code, fallback = 'runtime_error') {
  if (Object.hasOwn(HPS_ERROR_CATALOG, code)) return code;
  return Object.hasOwn(HPS_ERROR_CATALOG, fallback) ? fallback : 'runtime_error';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw catalogError('cancelled');
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function typeError(message) {
  throw new HpsError('invalid_request', { category: 'validation', requiredAction: 'fix_input' });
}

const STRING_FIELDS = Object.freeze({
  message: 4_096, query: 4_096, intent: 4_096, scope_id: 128, logical_id: 128,
  document_ref: 128, profile: 96, request_id: 256, idempotency_key: 256,
  checkpoint_id: 256, target_branch: 255
});

const INPUT_PROPERTY_SCHEMAS = Object.freeze({
  message: { type: 'string', maxLength: 4_096 },
  active_route: { anyOf: [{ type: 'string', maxLength: 96 }, { type: 'null' }] },
  host: { type: 'string', enum: ['codex', 'claude', 'opencode'] },
  query: { type: 'string', maxLength: 4_096 },
  known_entry_files: {
    type: 'array', minItems: 0, maxItems: 12,
    items: { type: 'string', minLength: 1, maxLength: 4_096 }
  },
  wiki_root: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 4_096 }] },
  intent: { type: 'string', maxLength: 4_096 },
  scope_id: { type: 'string', minLength: 1, maxLength: 128 },
  logical_id: { type: 'string', minLength: 1, maxLength: 128 },
  document_ref: { type: 'string', minLength: 1, maxLength: 128 },
  profile: { type: 'string', enum: ['hps-unit', 'hps-regression', 'context-collector'] },
  request_id: { type: 'string', minLength: 1, maxLength: 256 },
  idempotency_key: { type: 'string', minLength: 1, maxLength: 256 },
  checkpoint_id: { type: 'string', minLength: 1, maxLength: 256 },
  target_branch: { type: 'string', minLength: 1, maxLength: 255 },
  value: { type: 'object' },
  references: {
    type: 'array', maxItems: 256,
    items: {
      type: 'object', additionalProperties: false, required: ['logical_id'],
      properties: {
        logical_id: { type: 'string', minLength: 1, maxLength: 128 },
        status: { anyOf: [{ type: 'string', maxLength: 64 }, { type: 'null' }] },
        revision: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] }
      }
    }
  }
});

export function operationInputSchema(definition) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(definition.allowed.map((key) => [key, INPUT_PROPERTY_SCHEMAS[key]])),
    required: definition.required,
    ...(definition.exactlyOne.length > 0
      ? { oneOf: definition.exactlyOne.map((key) => ({ required: [key] })) }
      : {})
  };
}

export function isSafeAbsolutePath(value, { root = null } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096 || !path.isAbsolute(value)) return false;
  if (/[\0\r\n;&|$`<>]/u.test(value) || /:\/\//u.test(value)) return false;
  if (value.startsWith('//') || value.split(path.sep).includes('..')) return false;
  if (root !== null) {
    const relative = path.relative(root, value);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  }
  return true;
}

export function validateOperationInput(operation, input, { cwd = null } = {}) {
  const definition = HPS_OPERATION_DEFINITIONS[operation];
  if (!definition || !plainObject(input)) typeError('operation input must be an object');
  if (definition.deferred) return input;
  const allowed = new Set(definition.allowed);
  if (Object.keys(input).some((key) => !allowed.has(key))) typeError('unknown operation input field');
  if (definition.required.some((key) => !Object.hasOwn(input, key))) typeError('required operation input missing');
  if (definition.exactlyOne.length > 0 && definition.exactlyOne.filter((key) => Object.hasOwn(input, key)).length !== 1) {
    typeError('exactly one document identity is required');
  }
  for (const [key, maximum] of Object.entries(STRING_FIELDS)) {
    if (Object.hasOwn(input, key) && (typeof input[key] !== 'string' || input[key].length === 0 || Buffer.byteLength(input[key], 'utf8') > maximum)) {
      typeError(`${key} is invalid`);
    }
  }
  if (Object.hasOwn(input, 'active_route') && input.active_route !== null && (typeof input.active_route !== 'string' || input.active_route.length > 96)) typeError('active_route is invalid');
  if (Object.hasOwn(input, 'host') && !['codex', 'claude', 'opencode'].includes(input.host)) typeError('host is invalid');
  if (Object.hasOwn(input, 'value') && !plainObject(input.value)) typeError('value is invalid');
  if (Object.hasOwn(input, 'references')) {
    if (!Array.isArray(input.references) || input.references.length > 256 || input.references.some((reference) =>
      !plainObject(reference) || Object.keys(reference).some((key) => !['logical_id', 'status', 'revision'].includes(key)) ||
      typeof reference.logical_id !== 'string' || reference.logical_id.length === 0 || reference.logical_id.length > 128 ||
      (Object.hasOwn(reference, 'status') && reference.status !== null &&
        (typeof reference.status !== 'string' || reference.status.length > 64 || /[\0\r\n]/u.test(reference.status))) ||
      (Object.hasOwn(reference, 'revision') && reference.revision !== null &&
        (!Number.isSafeInteger(reference.revision) || reference.revision < 0))
    )) typeError('references are invalid');
  }
  if (Object.hasOwn(input, 'known_entry_files')) {
    if (!Array.isArray(input.known_entry_files) || input.known_entry_files.length > 12 ||
      input.known_entry_files.some((entry) => !isSafeAbsolutePath(entry, { root: cwd }))) {
      typeError('known_entry_files are invalid');
    }
  }
  if (Object.hasOwn(input, 'wiki_root') && input.wiki_root !== null && !isSafeAbsolutePath(input.wiki_root)) {
    typeError('wiki_root is invalid');
  }
  return input;
}

function knownErrorCode(error) {
  if (error instanceof HpsError) return Object.hasOwn(HPS_ERROR_CATALOG, error.code) ? error.code : 'runtime_error';
  const message = error instanceof Error ? error.message : '';
  if (message === 'scope_expired') return 'scope_expired';
  if (message === 'cancelled') return 'cancelled';
  if (message === 'timeout') return 'timeout';
  if (/profile.*allowlist/iu.test(message)) return 'profile_not_allowlisted';
  if (/session.*conflict/iu.test(message)) return 'session_conflict';
  if (/session|checkpoint|reference|credential|content|body|path|uri/iu.test(message)) return 'unsafe_session_input';
  if (/invalid|unknown|required|command|argv|override/iu.test(message)) return 'invalid_request';
  return 'runtime_error';
}

export function normalizeHpsError(error) {
  return catalogError(knownErrorCode(error));
}

function documentArguments(operation, cwd, input, signal) {
  const { scope_id = null, document_ref, logical_id, ...rest } = input;
  const request = {
    ...rest,
    ...(logical_id === undefined ? {} : { logical_id }),
    ...(document_ref === undefined ? {} : { document_ref })
  };
  return { cwd, action: operation.slice('document_'.length), request, scope_id, signal };
}

export async function dispatchHpsOperation({ runtime, operation, cwd, input, signal, requestId = null, onProgress = null }) {
  const definition = HPS_OPERATION_DEFINITIONS[operation];
  if (!definition) {
    throw new HpsError('operation_not_found', { category: 'routing', requiredAction: 'use_supported_operation' });
  }
  if (definition.deferred || DEFERRED_OPERATIONS.has(operation)) {
    throw new HpsError('operation_unavailable', { category: 'routing', requiredAction: 'use_supported_operation' });
  }
  validateOperationInput(operation, input, { cwd });
  const method = runtime?.[definition.method];
  if (typeof method !== 'function') throw new HpsError('operation_unavailable', { category: 'routing', requiredAction: 'use_supported_operation' });
  const progress = async (status, metrics = {}) => {
    if (typeof onProgress !== 'function') return;
    try {
      await onProgress({ request_id: requestId, phase: operation, status, metrics });
    } catch {
      // Progress is advisory. A broken notification sink must never alter the
      // operation result or leak an unnormalized callback error.
    }
  };
  await progress('started');
  try {
    throwIfAborted(signal);
    let args;
    if (operation === 'task_prepare') args = { cwd, input, signal };
    else if (operation.startsWith('document_') && ['document_resolve', 'document_search', 'document_get'].includes(operation)) {
      args = documentArguments(operation, cwd, input, signal);
    } else if (operation === 'runtime_doctor') args = { cwd, signal };
    else args = { cwd, ...input, signal };
    const result = await method.call(runtime, args);
    if (signal?.aborted) {
      if (operation === 'task_prepare' && result?.scope?.scope_id && typeof runtime?.invalidateScope === 'function') {
        await runtime.invalidateScope(result.scope.scope_id);
      }
      throw catalogError('cancelled');
    }
    await progress('completed', result?.metrics ?? {});
    return result;
  } catch (error) {
    await progress('failed');
    throw normalizeHpsError(error);
  }
}

export function exposedHpsTools() {
  return Object.entries(HPS_OPERATION_DEFINITIONS)
    .filter(([, definition]) => definition.exposed && !definition.deferred)
    .map(([name, definition]) => ({ name, definition }));
}
