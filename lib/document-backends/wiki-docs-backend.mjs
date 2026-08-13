import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  MAX_MANIFEST_BYTES,
  isQmdUriWithinRoot,
  validateConfigManifestEntry,
  validateWikiManifest
} from '../wiki-manifest.mjs';
import {
  extractMachineJson,
  validateWikiProjectConfig
} from '../wiki-config-provider.mjs';
import { markdownFromQmdResource } from '../wiki-qmd-content.mjs';
import {
  createSubmissionId,
  renderInboxSubmission
} from '../inbox-submitter.mjs';
import {
  inspectSubmissionText,
  inspectSubmissionMetadataIdentifier,
  parseCanonicalSafeDocument,
  validateAndSerializeSafeDocument
} from '../submission-safety.mjs';

const LOGICAL_ID = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DOCUMENT_TYPES = new Set(['design', 'plan', 'task', 'bug', 'decision', 'context', 'config', 'session']);
const MUTABLE_DOCUMENT_TYPES = new Set(['design', 'plan', 'task', 'bug', 'decision', 'context', 'session']);
const MUTATION_OPERATIONS = new Set(['create', 'update', 'archive', 'restore', 'config-change']);
const CONTENT_KINDS = new Set(['document', 'project-config', 'status-transition']);
const STATUS_VALUES = new Set(['active', 'completed', 'archived']);
const MAX_BATCH_MUTATIONS = 128;
const MAX_SESSION_REFS = 64;
const MAX_SESSION_FIELD_BYTES = 512;
const SESSION_REFERENCE_DOCUMENT_TYPES = new Set(['task', 'bug']);
const SAFE_ISSUE_CODES = new Set([
  'unknown_field', 'required', 'object_required', 'string_required',
  'array_required', 'array_length_out_of_range', 'length_out_of_range',
  'unsafe_text', 'unsupported_version', 'safe_document_required',
  'invalid_document_type', 'invalid_logical_id', 'invalid_relative_path',
  'invalid_operation', 'invalid_kind', 'invalid_language', 'invalid_symbol',
  'invalid_argument', 'positive_integer_required', 'invalid_status',
  'invalid_sha256', 'invalid_utc_rfc3339', 'uri_outside_root',
  'project_id_mismatch', 'fingerprint_mismatch', 'config_uri_mismatch',
  'config_page_hash_mismatch', 'config_required', 'active_required',
  'registry_project_id_mismatch', 'identity_fingerprint_mismatch',
  'collection_mismatch', 'registry_config_uri_outside_root',
  'private_key', 'authorization', 'credential_pattern', 'raw_markup',
  'source_syntax', 'external_url', 'log_or_diff', 'log_or_env_assignment',
  'long_verbatim_quote', 'high_entropy_credential', 'raw_source_detected',
  'source_scan_incomplete'
]);
const SAFE_SERIALIZATION_ERRORS = new Set([
  'safe_document_required', 'submission_safety_blocked',
  'raw_source_detected', 'source_scan_incomplete'
]);
const SAFE_TRANSPORT_ERRORS = new Set([
  'inbox_invalid_config', 'inbox_invalid_request', 'inbox_payload_too_large',
  'inbox_spawn_failed', 'inbox_response_too_large',
  'inbox_connection_closed', 'inbox_write_failed', 'inbox_process_exit',
  'inbox_timeout'
]);
const SAFE_ISSUE_PATH_SEGMENTS = new Set([
  'schema_version', 'format', 'title', 'sections', 'references', 'heading',
  'paragraphs', 'bullets', 'files', 'implementation_specs', 'commands',
  'operation', 'path', 'kind', 'language', 'symbol', 'inputs', 'outputs',
  'rules', 'errors', 'program', 'args', 'expected', 'document_type',
  'logical_id', 'project_id', 'project_fingerprint', 'development_mode',
  'branch_strategy', 'testing_strategy', 'completion_strategy', 'documentation',
  'enabled', 'backend', 'collection', 'root_uri', 'manifest_uri', 'submission',
  'mode', 'auto_submit', 'host_config', 'wiki', 'config_uri', 'documents',
  'uri', 'revision', 'status', 'content_sha256', 'updated_at', 'from_status',
  'to_status', 'project_config'
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value, allowed, required = []) {
  if (!isPlainObject(value)) return false;
  return Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key));
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

function validLogicalId(value) {
  return typeof value === 'string' && LOGICAL_ID.test(value);
}

function validRevision(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function boundedOpaqueText(value) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_SESSION_FIELD_BYTES && !/[\0\r\n]/u.test(value);
}

function validUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?Z$/u.exec(value);
  if (!match) return false;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return false;
  const date = new Date(instant);
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) && date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) && date.getUTCSeconds() === Number(match[6]);
}

function safeIssuePath(pathname, code) {
  if (code === 'unknown_field') return '$.unknown_field';
  if (pathname === '$') return '$';
  if (typeof pathname !== 'string' || pathname.length > 256 || !pathname.startsWith('$')) return '$';

  let offset = 1;
  while (offset < pathname.length) {
    if (pathname[offset] === '.') {
      const match = /^\.([a-z_][a-z0-9_]*)/u.exec(pathname.slice(offset));
      if (!match || !SAFE_ISSUE_PATH_SEGMENTS.has(match[1])) return '$';
      offset += match[0].length;
      continue;
    }
    if (pathname[offset] === '[') {
      const match = /^\[(\d{1,5})\]/u.exec(pathname.slice(offset));
      if (!match) return '$';
      offset += match[0].length;
      continue;
    }
    return '$';
  }
  return pathname;
}

function safeIssues(errors) {
  if (!Array.isArray(errors)) return undefined;
  const sanitized = errors.slice(0, 32).flatMap((error) => {
    if (!isPlainObject(error) || typeof error.path !== 'string' || typeof error.code !== 'string') return [];
    const code = SAFE_ISSUE_CODES.has(error.code) ? error.code : 'validation_failed';
    return [{
      path: safeIssuePath(error.path, code),
      code
    }];
  });
  return sanitized.length > 0 ? sanitized : undefined;
}

function documentSummary(logicalId, entry) {
  return {
    logical_id: logicalId,
    document_type: entry.document_type,
    uri: entry.uri,
    revision: entry.revision,
    status: entry.status,
    content_sha256: entry.content_sha256,
    updated_at: entry.updated_at
  };
}

function resultDocument(logicalId, entry, content) {
  return { ...documentSummary(logicalId, entry), content };
}

function machineBlock(marker, value) {
  return `<!-- ${marker}:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- ${marker}:end -->\n`;
}

function previewFor(prepared) {
  return {
    operation: prepared.operation,
    document_type: prepared.documentType,
    logical_id: prepared.logicalId,
    base_revision: prepared.baseRevision,
    proposed_revision: prepared.proposedRevision
  };
}

function submissionPolicySnapshot(config) {
  const documentation = config?.documentation;
  return Object.freeze({
    enabled: documentation?.enabled === true,
    autoSubmit: documentation?.submission?.auto_submit === true
  });
}

/**
 * Read-only Wiki adapter plus the single Inbox-only mutation gate.  It never
 * writes project files, Wiki pages, qmd indexes, or Inbox paths directly.
 */
export class WikiDocsBackend {
  constructor(options = {}, dependencies = {}) {
    this.projectRoot = options.projectRoot;
    this.config = options.config;
    this.projectId = options.projectId ?? options.config?.project_id ?? null;
    this.configUri = options.configUri ?? options.config_uri;
    this.hostConfig = options.hostConfig ?? options.host_config;
    this.qmdClient = options.qmdClient ?? options.qmd_client;
    this.submitter = options.submitter ?? null;
    this.serializeSafeDocument = dependencies.serializeSafeDocument ??
      dependencies.validateAndSerializeSafeDocument ?? options.serializeSafeDocument ??
      options.validateAndSerializeSafeDocument ?? validateAndSerializeSafeDocument;
    this.sourceSimilarityGuard = dependencies.sourceSimilarityGuard ?? options.sourceSimilarityGuard ?? null;
    const customInspectText = dependencies.inspectSubmissionText ?? options.inspectSubmissionText ?? null;
    this.inspectText = customInspectText ?? inspectSubmissionText;
    this.inspectMetadataIdentifier = dependencies.inspectSubmissionMetadataIdentifier ??
      options.inspectSubmissionMetadataIdentifier ?? inspectSubmissionMetadataIdentifier;
    this.createSubmissionId = dependencies.createSubmissionId ?? options.createSubmissionId ?? createSubmissionId;
    this.renderInboxSubmission = dependencies.renderInboxSubmission ?? options.renderInboxSubmission ?? renderInboxSubmission;
    this.extractMachineJson = dependencies.extractMachineJson ?? options.extractMachineJson ?? extractMachineJson;
    this.validateProjectConfig = dependencies.validateWikiProjectConfig ??
      options.validateWikiProjectConfig ?? validateWikiProjectConfig;
    this.configurationError = this.#validateConstructor();
  }

  #result(status, fields = {}) {
    return {
      status,
      backend: 'wiki',
      project_id: this.#resultProjectId(),
      ...fields
    };
  }

  #failure(status, errorCode, fields = {}) {
    return this.#result(status, { error_code: errorCode, ...fields });
  }

  #metadataSafetyIssue(pathname, value, { projectId = false } = {}) {
    if (typeof value !== 'string') return { path: pathname, code: 'metadata_safety' };
    let inspection;
    try {
      inspection = this.inspectMetadataIdentifier(value, { projectId });
    } catch {
      return { path: pathname, code: 'metadata_safety' };
    }
    if (inspection?.ok !== true) {
      return { path: pathname, code: typeof inspection?.category === 'string' ? inspection.category : 'metadata_safety' };
    }
    return null;
  }

  #resultProjectId() {
    return this.#metadataSafetyIssue('$.project_id', this.projectId, { projectId: true })
      ? null
      : this.projectId;
  }

  #metadataSafetyFailure(issue) {
    return this.#failure('submission_safety_blocked', 'submission_safety_blocked', { errors: [issue] });
  }

  #validateConstructor() {
    if (!isAbsolutePath(this.projectRoot)) return 'wiki_runtime_config_invalid';
    if (!isPlainObject(this.config) || typeof this.configUri !== 'string' ||
        !isPlainObject(this.hostConfig) || !isPlainObject(this.hostConfig.wiki)) {
      return 'wiki_runtime_config_invalid';
    }
    const validation = this.validateProjectConfig(this.config, {
      project_id: this.config.project_id,
      project_fingerprint: this.config.project_fingerprint,
      config_uri: this.configUri
    }, this.hostConfig);
    if (!validation?.ok) return 'wiki_runtime_config_invalid';
    if (this.projectId !== this.config.project_id) return 'wiki_runtime_config_invalid';
    const documentation = this.config.documentation;
    if (!isQmdUriWithinRoot(this.configUri, documentation.collection, documentation.root_uri)) {
      return 'wiki_runtime_config_invalid';
    }
    return null;
  }

  #configurationFailure() {
    return this.#failure('wiki_unavailable', this.configurationError ?? 'wiki_runtime_config_invalid');
  }

  #manifestConfigEntry(manifest) {
    const entry = manifest?.documents?.['horspowers-config'];
    if (!isPlainObject(entry) || entry.document_type !== 'config' || entry.status !== 'active' ||
        entry.uri !== this.configUri || !validRevision(entry.revision, 1) ||
        typeof entry.content_sha256 !== 'string' || !SHA256.test(entry.content_sha256)) {
      return null;
    }
    return entry;
  }

  #manifestUriIndex(manifest) {
    const byUri = new Map();
    for (const [logicalId, entry] of Object.entries(manifest.documents)) {
      if (byUri.has(entry.uri)) return null;
      byUri.set(entry.uri, { logicalId, entry });
    }
    return byUri;
  }

  async #exactPage(uri) {
    try {
      const outcome = await this.qmdClient?.getExact?.(uri);
      const content = outcome?.ok === true ? outcome.result?.content : null;
      if (!Array.isArray(content) || content.length !== 1) return null;
      const [item] = content;
      if (item?.type === 'text' && typeof item.text === 'string') return item.text;
      if (item?.type === 'resource' && typeof item.resource?.text === 'string') {
        return markdownFromQmdResource(item.resource.text);
      }
      return null;
    } catch {
      return null;
    }
  }

  async #loadManifest() {
    if (this.configurationError) return { ok: false, result: this.#configurationFailure() };
    const page = await this.#exactPage(this.config.documentation.manifest_uri);
    if (page === null) {
      return { ok: false, result: this.#failure('wiki_unavailable', 'qmd_get_failed') };
    }
    const extracted = this.extractMachineJson(page, 'horspowers-manifest', MAX_MANIFEST_BYTES);
    if (!extracted?.ok) {
      return {
        ok: false,
        result: this.#failure('manifest_invalid', extracted?.error_code ?? 'machine_block_invalid', {
          ...(safeIssues(extracted?.errors) ? { errors: safeIssues(extracted.errors) } : {})
        })
      };
    }
    const validated = validateWikiManifest(extracted.value, this.config);
    if (!validated?.ok) {
      const status = validated?.error_code === 'manifest_incompatible' ? 'manifest_incompatible' : 'manifest_invalid';
      return {
        ok: false,
        result: this.#failure(status, validated?.error_code ?? 'manifest_invalid', {
          ...(safeIssues(validated?.errors) ? { errors: safeIssues(validated.errors) } : {})
        })
      };
    }
    if (!this.#manifestConfigEntry(validated.manifest)) {
      return { ok: false, result: this.#failure('config_manifest_mismatch', 'config_manifest_mismatch') };
    }
    if (this.#manifestUriIndex(validated.manifest) === null) {
      return { ok: false, result: this.#failure('manifest_invalid', 'duplicate_document_uri') };
    }
    const currentConfig = await this.#currentConfig(validated.manifest);
    if (!currentConfig.ok) return currentConfig;
    return {
      ok: true,
      manifest: validated.manifest,
      configEntry: currentConfig.entry,
      currentConfig: currentConfig.config
    };
  }

  async #verifyEntryBody(entry) {
    const body = await this.#exactPage(entry.uri);
    if (body === null) return { ok: false, result: this.#failure('wiki_unavailable', 'qmd_get_failed') };
    if (sha256(body) !== entry.content_sha256) {
      return { ok: false, result: this.#failure('manifest_content_mismatch', 'manifest_content_mismatch') };
    }
    return { ok: true, body };
  }

  #validateReadRequest(request, keys, required) {
    if (!hasOnlyKeys(request, keys, required)) {
      return this.#failure('invalid_request', 'request_invalid');
    }
    return null;
  }

  async get(request = {}) {
    const requestError = this.#validateReadRequest(request, ['logical_id'], ['logical_id']);
    if (requestError) return requestError;
    if (!validLogicalId(request.logical_id)) return this.#failure('invalid_request', 'logical_id_invalid');

    const loaded = await this.#loadManifest();
    if (!loaded.ok) return loaded.result;
    const entry = loaded.manifest.documents[request.logical_id];
    if (!entry) return this.#failure('document_not_found', 'document_not_found');
    const verified = await this.#verifyEntryBody(entry);
    if (!verified.ok) return verified.result;
    return this.#result('ok', { document: resultDocument(request.logical_id, entry, verified.body) });
  }

  async search(request = {}) {
    const requestError = this.#validateReadRequest(request, ['query', 'intent'], ['query', 'intent']);
    if (requestError) return requestError;
    if (typeof request.query !== 'string' || typeof request.intent !== 'string') {
      return this.#failure('invalid_request', 'search_query_or_intent_invalid');
    }

    const loaded = await this.#loadManifest();
    if (!loaded.ok) return loaded.result;
    const byUri = this.#manifestUriIndex(loaded.manifest);
    if (byUri === null) return this.#failure('manifest_invalid', 'duplicate_document_uri');

    let outcome;
    try {
      outcome = await this.qmdClient?.search?.({ query: request.query, intent: request.intent });
    } catch {
      outcome = null;
    }
    const results = outcome?.ok === true ? outcome.result?.structuredContent?.results : null;
    if (!Array.isArray(results)) return this.#failure('wiki_unavailable', 'qmd_search_failed');

    const documents = [];
    const seenUris = new Set();
    const seenLogicalIds = new Set();
    for (const candidate of results) {
      if (!isPlainObject(candidate) || typeof candidate.uri !== 'string' ||
          !isQmdUriWithinRoot(candidate.uri, this.config.documentation.collection, this.config.documentation.root_uri)) {
        return this.#failure('wiki_search_invalid', 'wiki_search_invalid');
      }
      const indexed = byUri.get(candidate.uri);
      if (!indexed || seenUris.has(candidate.uri) || seenLogicalIds.has(indexed.logicalId)) {
        return this.#failure('wiki_search_invalid', 'wiki_search_invalid');
      }
      seenUris.add(candidate.uri);
      seenLogicalIds.add(indexed.logicalId);
      const document = documentSummary(indexed.logicalId, indexed.entry);
      if (typeof candidate.text === 'string') document.text = candidate.text;
      documents.push(document);
    }
    return this.#result('ok', { documents });
  }

  #actionMutation(action, request) {
    const allowed = ['document_type', 'logical_id', 'base_revision', 'content_kind', 'content'];
    if (!hasOnlyKeys(request, allowed, ['document_type', 'logical_id', 'base_revision', 'content_kind', 'content'])) {
      return { ok: false, result: this.#failure('invalid_request', 'mutation_request_invalid') };
    }
    return { ok: true, mutation: { operation: action, ...request } };
  }

  async create(request = {}, options = {}) {
    const mutation = this.#actionMutation('create', request);
    return mutation.ok ? this.mutate(mutation.mutation, options) : mutation.result;
  }

  async update(request = {}, options = {}) {
    const mutation = this.#actionMutation('update', request);
    return mutation.ok ? this.mutate(mutation.mutation, options) : mutation.result;
  }

  async archive(request = {}, options = {}) {
    const mutation = this.#actionMutation('archive', request);
    return mutation.ok ? this.mutate(mutation.mutation, options) : mutation.result;
  }

  async restore(request = {}, options = {}) {
    const mutation = this.#actionMutation('restore', request);
    return mutation.ok ? this.mutate(mutation.mutation, options) : mutation.result;
  }

  async configChange(request = {}, options = {}) {
    const mutation = this.#actionMutation('config-change', request);
    return mutation.ok ? this.mutate(mutation.mutation, options) : mutation.result;
  }

  #validateMutationEnvelope(mutation) {
    const allowed = ['operation', 'document_type', 'logical_id', 'base_revision', 'content_kind', 'content'];
    const required = ['operation', 'document_type', 'logical_id', 'base_revision', 'content_kind', 'content'];
    if (!hasOnlyKeys(mutation, allowed, required)) return this.#failure('invalid_request', 'mutation_invalid');
    if (!MUTATION_OPERATIONS.has(mutation.operation)) return this.#failure('invalid_request', 'operation_not_supported');
    if (!DOCUMENT_TYPES.has(mutation.document_type)) return this.#failure('invalid_request', 'document_type_invalid');
    if (!validLogicalId(mutation.logical_id)) return this.#failure('invalid_request', 'logical_id_invalid');
    const logicalIdIssue = this.#metadataSafetyIssue('$.logical_id', mutation.logical_id);
    if (logicalIdIssue) return this.#metadataSafetyFailure(logicalIdIssue);
    if (!CONTENT_KINDS.has(mutation.content_kind)) return this.#failure('invalid_request', 'content_kind_invalid');
    if (!validRevision(mutation.base_revision, 0)) {
      return this.#failure('invalid_request', 'base_revision_invalid');
    }
    return null;
  }

  #baseRevision(mutation, expectedRevision) {
    if (mutation.base_revision !== undefined && mutation.base_revision !== expectedRevision) {
      return { ok: false, result: this.#failure('document_conflict', 'base_revision_mismatch') };
    }
    return { ok: true, value: expectedRevision };
  }

  #entryForMutation(manifest, mutation) {
    const entry = manifest.documents[mutation.logical_id];
    if (!entry) return { ok: false, result: this.#failure('document_not_found', 'document_not_found') };
    if (entry.document_type !== mutation.document_type) {
      return { ok: false, result: this.#failure('invalid_request', 'document_type_mismatch') };
    }
    return { ok: true, entry };
  }

  #validateReferences(content, manifest) {
    if (!Array.isArray(content?.references)) return this.#failure('safe_document_required', 'safe_document_required');
    for (const reference of content.references) {
      const entry = manifest.documents[reference.logical_id];
      if (!entry || entry.document_type !== reference.document_type) {
        return this.#failure('invalid_request', 'reference_not_in_manifest');
      }
    }
    return null;
  }

  async #serializeDocument(content, manifest) {
    let serialized;
    try {
      serialized = this.sourceSimilarityGuard
        ? await this.serializeSafeDocument(content, this.projectRoot, { sourceSimilarityGuard: this.sourceSimilarityGuard })
        : await this.serializeSafeDocument(content, this.projectRoot);
    } catch {
      serialized = null;
    }
    if (!serialized?.ok || typeof serialized.markdown !== 'string') {
      const code = SAFE_SERIALIZATION_ERRORS.has(serialized?.error_code)
        ? serialized.error_code
        : 'safe_document_required';
      return {
        ok: false,
        result: this.#failure(code, code, {
          ...(safeIssues(serialized?.errors) ? { errors: safeIssues(serialized.errors) } : {})
        })
      };
    }
    const referenceError = this.#validateReferences(content, manifest);
    if (referenceError) return { ok: false, result: referenceError };
    return { ok: true, proposedDocument: serialized.markdown };
  }

  async #prepareDocumentMutation(mutation, manifest) {
    if (mutation.content_kind !== 'document' || !MUTABLE_DOCUMENT_TYPES.has(mutation.document_type)) {
      return { ok: false, result: this.#failure('invalid_request', 'document_mutation_required') };
    }

    let baseRevision;
    let sourceEntry = null;
    if (mutation.operation === 'create') {
      if (manifest.documents[mutation.logical_id]) {
        return { ok: false, result: this.#failure('document_conflict', 'document_already_exists') };
      }
      const base = this.#baseRevision(mutation, 0);
      if (!base.ok) return base;
      baseRevision = base.value;
    } else if (mutation.operation === 'update') {
      const target = this.#entryForMutation(manifest, mutation);
      if (!target.ok) return target;
      if (target.entry.status === 'archived') {
        return { ok: false, result: this.#failure('invalid_request', 'document_archived') };
      }
      const base = this.#baseRevision(mutation, target.entry.revision);
      if (!base.ok) return base;
      const verified = await this.#verifyEntryBody(target.entry);
      if (!verified.ok) return verified;
      baseRevision = base.value;
      sourceEntry = target.entry;
    } else {
      return { ok: false, result: this.#failure('invalid_request', 'operation_content_kind_mismatch') };
    }

    const serialized = await this.#serializeDocument(mutation.content, manifest);
    if (!serialized.ok) return serialized;
    return {
      ok: true,
      prepared: {
        operation: mutation.operation,
        documentType: mutation.document_type,
        logicalId: mutation.logical_id,
        baseRevision,
        proposedRevision: baseRevision + 1,
        proposedDocument: serialized.proposedDocument,
        ...(sourceEntry ? {
          sourceUri: sourceEntry.uri,
          sourceStatus: sourceEntry.status,
          sourceRevision: sourceEntry.revision,
          sourceContentSha256: sourceEntry.content_sha256,
          contentSha256: sha256(serialized.proposedDocument)
        } : {})
      }
    };
  }

  async #currentConfig(manifest) {
    const page = await this.#exactPage(this.configUri);
    if (page === null) return { ok: false, result: this.#failure('wiki_unavailable', 'qmd_get_failed') };
    const entryValidation = validateConfigManifestEntry(manifest, {
      config_uri: this.configUri,
      config_page: page
    });
    if (!entryValidation?.ok) {
      return {
        ok: false,
        result: this.#failure('config_manifest_mismatch', 'config_manifest_mismatch', {
          ...(safeIssues(entryValidation?.errors) ? { errors: safeIssues(entryValidation.errors) } : {})
        })
      };
    }
    const extracted = this.extractMachineJson(page, 'horspowers-config', MAX_MANIFEST_BYTES);
    if (!extracted?.ok) {
      return { ok: false, result: this.#failure('config_manifest_mismatch', extracted?.error_code ?? 'machine_block_invalid') };
    }
    const current = this.validateProjectConfig(extracted.value, {
      project_id: this.config.project_id,
      project_fingerprint: this.config.project_fingerprint,
      config_uri: this.configUri
    }, this.hostConfig);
    if (!current?.ok) {
      return {
        ok: false,
        result: this.#failure('config_manifest_mismatch', current?.error_code ?? 'project_config_invalid', {
          ...(safeIssues(current?.errors) ? { errors: safeIssues(current.errors) } : {})
        })
      };
    }
    return { ok: true, entry: entryValidation.entry, config: current.config };
  }

  #sameWikiLocation(candidate) {
    const expected = this.config.documentation;
    const actual = candidate?.documentation;
    return actual?.collection === expected.collection && actual?.root_uri === expected.root_uri &&
      actual?.manifest_uri === expected.manifest_uri && actual?.backend === 'wiki' &&
      actual?.submission?.mode === 'inbox-only';
  }

  #inspectProjectConfig(value) {
    // Project IDs are structured metadata, not prose. Use the same strict
    // identifier scanner used by the Inbox envelope so nested GitLab paths
    // remain compatible without creating a generic-text bypass.
    const projectIdInspection = this.inspectMetadataIdentifier(value.project_id, { projectId: true });
    if (!projectIdInspection?.ok) return projectIdInspection;
    const scanValue = {
      ...value,
      // These values are protocol structure rather than proposed prose. The
      // project ID was safety-scanned above; collection and qmd URIs are
      // already strictly bound to the verified host configuration and root.
      project_id: 'project-id',
      project_fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      documentation: {
        ...value.documentation,
        // These two values are already strict qmd URIs and bound to the
        // constructor's verified project root.  Masking them prevents the
        // generic external-URL detector from treating a trusted qmd scheme as
        // user-supplied prose while keeping every other config field scanned.
        collection: 'collection',
        root_uri: 'root',
        manifest_uri: 'manifest'
      }
    };
    let text;
    try {
      text = [
        scanValue.project_id,
        scanValue.project_fingerprint,
        scanValue.development_mode,
        scanValue.branch_strategy,
        scanValue.testing_strategy,
        scanValue.completion_strategy,
        String(scanValue.documentation.enabled),
        scanValue.documentation.backend,
        scanValue.documentation.collection,
        scanValue.documentation.root_uri,
        scanValue.documentation.manifest_uri,
        scanValue.documentation.submission.mode,
        String(scanValue.documentation.submission.auto_submit)
      ].join('\n');
    } catch {
      return { ok: false, category: 'project_config_serialization' };
    }
    return this.inspectText(text);
  }

  async #prepareConfigMutation(mutation, manifest, currentConfig) {
    if (mutation.content_kind !== 'project-config' || mutation.document_type !== 'config' ||
        mutation.logical_id !== 'horspowers-config') {
      return { ok: false, result: this.#failure('invalid_request', 'project_config_mutation_required') };
    }
    const current = currentConfig ?? await this.#currentConfig(manifest);
    if (!currentConfig && !current.ok) return current;
    const currentEntry = currentConfig ? currentConfig.entry : current.entry;
    const base = this.#baseRevision(mutation, currentEntry.revision);
    if (!base.ok) return base;
    const candidate = this.validateProjectConfig(mutation.content, {
      project_id: this.config.project_id,
      project_fingerprint: this.config.project_fingerprint,
      config_uri: this.configUri
    }, this.hostConfig);
    if (!candidate?.ok) {
      return {
        ok: false,
        result: this.#failure('project_config_invalid', candidate?.error_code ?? 'project_config_invalid', {
          ...(safeIssues(candidate?.errors) ? { errors: safeIssues(candidate.errors) } : {})
        })
      };
    }
    if (!this.#sameWikiLocation(candidate.config)) {
      return { ok: false, result: this.#failure('project_config_incompatible', 'config_documentation_scope_mismatch') };
    }
    const inspection = this.#inspectProjectConfig(candidate.config);
    if (!inspection?.ok) {
      return {
        ok: false,
        result: this.#failure('submission_safety_blocked', 'submission_safety_blocked', {
          errors: [{ path: '$.project_config', code: inspection?.category ?? 'project_config_safety' }]
        })
      };
    }
    return {
      ok: true,
      prepared: {
        operation: 'config-change',
        documentType: 'config',
        logicalId: 'horspowers-config',
        baseRevision: base.value,
        proposedRevision: base.value + 1,
        proposedDocument: machineBlock('horspowers-config', candidate.config)
      }
    };
  }

  async #prepareTransitionMutation(mutation, manifest) {
    if (mutation.content_kind !== 'status-transition' ||
        !hasOnlyKeys(mutation.content, ['uri', 'content_sha256', 'from_status', 'to_status'], ['uri', 'content_sha256', 'from_status', 'to_status'])) {
      return { ok: false, result: this.#failure('invalid_request', 'status_transition_required') };
    }
    if (!MUTABLE_DOCUMENT_TYPES.has(mutation.document_type)) {
      return { ok: false, result: this.#failure('invalid_request', 'status_transition_document_type_invalid') };
    }
    const target = this.#entryForMutation(manifest, mutation);
    if (!target.ok) return target;
    const transition = mutation.content;
    const expectedToStatus = mutation.operation === 'archive' ? 'archived' : 'active';
    const allowedFrom = mutation.operation === 'archive'
      ? new Set(['active', 'completed'])
      : new Set(['archived']);
    if (transition.uri !== target.entry.uri || transition.content_sha256 !== target.entry.content_sha256 ||
        transition.from_status !== target.entry.status || transition.to_status !== expectedToStatus ||
        !allowedFrom.has(transition.from_status) || !STATUS_VALUES.has(transition.to_status)) {
      return { ok: false, result: this.#failure('invalid_request', 'status_transition_mismatch') };
    }
    const base = this.#baseRevision(mutation, target.entry.revision);
    if (!base.ok) return base;
    const verified = await this.#verifyEntryBody(target.entry);
    if (!verified.ok) return verified;
    return {
      ok: true,
      prepared: {
        operation: mutation.operation,
        documentType: mutation.document_type,
        logicalId: mutation.logical_id,
        baseRevision: base.value,
        proposedRevision: base.value + 1,
        proposedDocument: machineBlock('horspowers-status-transition', transition)
      }
    };
  }

  async #prepareMutation(mutation) {
    const envelopeError = this.#validateMutationEnvelope(mutation);
    if (envelopeError) return { ok: false, result: envelopeError };
    const loaded = await this.#loadManifest();
    if (!loaded.ok) return loaded;
    const submissionPolicy = submissionPolicySnapshot(loaded.currentConfig);
    if (!submissionPolicy.enabled && mutation.operation !== 'config-change') {
      return { ok: false, result: this.#failure('documentation_disabled', 'documentation_disabled') };
    }
    const projectIdIssue = this.#metadataSafetyIssue('$.project_id', this.projectId, { projectId: true });
    if (projectIdIssue) return { ok: false, result: this.#metadataSafetyFailure(projectIdIssue) };
    let outcome;
    if (mutation.operation === 'create' || mutation.operation === 'update') {
      outcome = await this.#prepareDocumentMutation(mutation, loaded.manifest);
    } else if (mutation.operation === 'config-change') {
      outcome = await this.#prepareConfigMutation(mutation, loaded.manifest, {
        entry: loaded.configEntry,
        config: loaded.currentConfig
      });
    } else {
      outcome = await this.#prepareTransitionMutation(mutation, loaded.manifest);
    }
    if (!outcome.ok) return outcome;
    return {
      ok: true,
      prepared: {
        ...outcome.prepared,
        submissionPolicy
      }
    };
  }

  #prepareDependentTransitionMutation(mutation, prerequisite) {
    const envelopeError = this.#validateMutationEnvelope(mutation);
    if (envelopeError) return { ok: false, result: envelopeError };
    if (mutation.operation !== 'archive' || mutation.content_kind !== 'status-transition' ||
        !hasOnlyKeys(mutation.content, ['uri', 'content_sha256', 'from_status', 'to_status'], ['uri', 'content_sha256', 'from_status', 'to_status'])) {
      return { ok: false, result: this.#failure('invalid_request', 'dependent_status_transition_required') };
    }
    if (!MUTABLE_DOCUMENT_TYPES.has(mutation.document_type) || !prerequisite ||
        prerequisite.operation !== 'update' || prerequisite.documentType !== mutation.document_type ||
        prerequisite.logicalId !== mutation.logical_id || !validRevision(prerequisite.proposedRevision, 1) ||
        typeof prerequisite.sourceUri !== 'string' || typeof prerequisite.sourceContentSha256 !== 'string' ||
        typeof prerequisite.contentSha256 !== 'string') {
      return { ok: false, result: this.#failure('invalid_request', 'dependency_invalid') };
    }
    if (!prerequisite.submissionPolicy?.enabled) {
      return { ok: false, result: this.#failure('documentation_disabled', 'documentation_disabled') };
    }
    const transition = mutation.content;
    if (mutation.base_revision !== prerequisite.proposedRevision || transition.uri !== prerequisite.sourceUri ||
        transition.content_sha256 !== prerequisite.sourceContentSha256 ||
        transition.from_status !== prerequisite.sourceStatus || transition.to_status !== 'archived' ||
        !new Set(['active', 'completed']).has(prerequisite.sourceStatus)) {
      return { ok: false, result: this.#failure('document_conflict', 'dependency_state_mismatch') };
    }
    const virtualTransition = {
      uri: prerequisite.sourceUri,
      content_sha256: prerequisite.contentSha256,
      from_status: prerequisite.sourceStatus,
      to_status: 'archived'
    };
    return {
      ok: true,
      prepared: {
        operation: 'archive',
        documentType: mutation.document_type,
        logicalId: mutation.logical_id,
        baseRevision: prerequisite.proposedRevision,
        proposedRevision: prerequisite.proposedRevision + 1,
        proposedDocument: machineBlock('horspowers-status-transition', virtualTransition),
        submissionPolicy: prerequisite.submissionPolicy
      }
    };
  }

  #canSubmit(confirmed, prepared) {
    const entries = Array.isArray(prepared) ? prepared : [prepared];
    return entries.length > 0 && entries.every(entry => entry?.submissionPolicy &&
      (entry.submissionPolicy.autoSubmit === true || confirmed === true));
  }

  async #submitPrepared(prepared) {
    if (!this.submitter || typeof this.submitter.submit !== 'function') {
      return this.#failure('submission_failed', 'inbox_submitter_unavailable');
    }
    let submissionId;
    let payload;
    try {
      submissionId = this.createSubmissionId();
      const metadata = {
        schema_version: 1,
        submission_id: submissionId,
        source: 'Ugreen-jump-base',
        project_id: this.projectId,
        project_fingerprint: this.config.project_fingerprint,
        document_type: prepared.documentType,
        logical_id: prepared.logicalId,
        operation: prepared.operation,
        base_revision: prepared.baseRevision,
        proposed_revision: prepared.proposedRevision,
        status: 'pending-review'
      };
      payload = this.renderInboxSubmission({ metadata, proposedDocument: prepared.proposedDocument });
    } catch {
      return this.#failure('submission_failed', 'inbox_payload_invalid');
    }
    let submitted;
    try {
      submitted = await this.submitter.submit({ submissionId, payload });
    } catch {
      submitted = null;
    }
    if (!submitted?.ok) {
      const errorCode = SAFE_TRANSPORT_ERRORS.has(submitted?.error_code)
        ? submitted.error_code
        : 'inbox_submit_failed';
      return this.#failure('submission_failed', errorCode, { submission_id: submissionId });
    }
    return this.#result('submitted_pending_review', {
      ...previewFor(prepared),
      submission_id: submissionId,
      ...(typeof submitted.filename === 'string' ? { filename: submitted.filename } : {})
    });
  }

  async mutate(mutation, { confirmed = false } = {}) {
    const prepared = await this.#prepareMutation(mutation);
    if (!prepared.ok) return prepared.result;
    if (!this.#canSubmit(confirmed, prepared.prepared)) {
      return this.#result('confirmation_required', { preview: previewFor(prepared.prepared) });
    }
    return this.#submitPrepared(prepared.prepared);
  }

  async mutateBatch(mutations, { confirmed = false } = {}) {
    if (isPlainObject(mutations) && Array.isArray(mutations.mutations)) {
      confirmed = mutations.confirmed === true || confirmed === true;
      mutations = mutations.mutations;
    }
    if (!Array.isArray(mutations) || mutations.length === 0 || mutations.length > MAX_BATCH_MUTATIONS) {
      return this.#failure('invalid_request', 'mutation_batch_invalid');
    }
    const projectIdIssue = this.#metadataSafetyIssue('$.project_id', this.projectId, { projectId: true });
    if (projectIdIssue) return this.#metadataSafetyFailure(projectIdIssue);
    const prepared = [];
    for (const [index, suppliedMutation] of mutations.entries()) {
      let mutation = suppliedMutation;
      let dependsOn = null;
      if (isPlainObject(suppliedMutation) && Object.hasOwn(suppliedMutation, 'mutation')) {
        if (!hasOnlyKeys(suppliedMutation, ['operation', 'mutation', 'depends_on'], ['operation', 'mutation']) ||
            !isPlainObject(suppliedMutation.mutation) || Object.hasOwn(suppliedMutation.mutation, 'operation')) {
          return this.#failure('invalid_request', 'mutation_batch_invalid');
        }
        if (Object.hasOwn(suppliedMutation, 'depends_on')) {
          if (!Number.isSafeInteger(suppliedMutation.depends_on) || suppliedMutation.depends_on < 0 ||
              suppliedMutation.depends_on >= index) {
            return this.#failure('invalid_request', 'mutation_batch_dependency_invalid');
          }
          dependsOn = suppliedMutation.depends_on;
        }
        mutation = { ...suppliedMutation.mutation, operation: suppliedMutation.operation };
      }
      const outcome = dependsOn === null
        ? await this.#prepareMutation(mutation)
        : this.#prepareDependentTransitionMutation(mutation, prepared[dependsOn]?.prepared);
      if (!outcome.ok) return outcome.result;
      prepared.push({ prepared: outcome.prepared, dependsOn });
    }
    if (!this.#canSubmit(confirmed, prepared.map(entry => entry.prepared))) {
      return this.#result('confirmation_required', { previews: prepared.map(entry => previewFor(entry.prepared)) });
    }

    const submitted = [];
    const failures = [];
    const failedDependencies = new Set();
    for (const [index, entry] of prepared.entries()) {
      const preparedEntry = entry.prepared;
      if (entry.dependsOn !== null && failedDependencies.has(entry.dependsOn)) {
        failures.push({
          logical_id: preparedEntry.logicalId,
          operation: preparedEntry.operation,
          error_code: 'submission_dependency_failed'
        });
        failedDependencies.add(index);
        continue;
      }
      const outcome = await this.#submitPrepared(preparedEntry);
      if (outcome.status === 'submitted_pending_review') {
        submitted.push({
          submission_id: outcome.submission_id,
          logical_id: preparedEntry.logicalId,
          operation: preparedEntry.operation,
          ...(outcome.filename ? { filename: outcome.filename } : {})
        });
      } else {
        failures.push({
          logical_id: preparedEntry.logicalId,
          operation: preparedEntry.operation,
          error_code: outcome.error_code,
          ...(typeof outcome.submission_id === 'string' ? { submission_id: outcome.submission_id } : {})
        });
        failedDependencies.add(index);
      }
    }
    if (failures.length === 0) return this.#result('submitted_pending_review', { submissions: submitted });
    if (submitted.length === 0) return this.#failure('submission_failed', 'batch_submission_failed', { failures });
    return this.#result('partially_submitted', { submissions: submitted, failures });
  }

  #recordSessionRequest(request) {
    if (!hasOnlyKeys(request, ['session', 'document_refs', 'auto_archive_completed'], ['session', 'document_refs', 'auto_archive_completed'])) {
      return { ok: false, result: this.#failure('invalid_request', 'session_request_invalid') };
    }
    if (!hasOnlyKeys(request.session, ['session_id', 'ended_at', 'branch'], ['session_id', 'ended_at', 'branch']) ||
        !boundedOpaqueText(request.session.session_id) || !validUtcTimestamp(request.session.ended_at) ||
        !boundedOpaqueText(request.session.branch)) {
      return { ok: false, result: this.#failure('invalid_request', 'session_invalid') };
    }
    const refs = request.document_refs;
    if (!Array.isArray(refs) || refs.length > MAX_SESSION_REFS ||
        request.auto_archive_completed !== undefined && typeof request.auto_archive_completed !== 'boolean') {
      return { ok: false, result: this.#failure('invalid_request', 'session_refs_invalid') };
    }
    const seen = new Set();
    for (const reference of refs) {
      if (!hasOnlyKeys(reference, ['document_type', 'logical_id'], ['document_type', 'logical_id']) ||
          !SESSION_REFERENCE_DOCUMENT_TYPES.has(reference.document_type) || !validLogicalId(reference.logical_id)) {
        return { ok: false, result: this.#failure('invalid_request', 'session_refs_invalid') };
      }
      if (seen.has(reference.logical_id)) {
        return { ok: false, result: this.#failure('invalid_request', 'session_reference_duplicate') };
      }
      seen.add(reference.logical_id);
    }
    return { ok: true, refs };
  }

  async recordSession(request = {}, options = {}) {
    const validated = this.#recordSessionRequest(request);
    if (!validated.ok) return validated.result;
    const loaded = await this.#loadManifest();
    if (!loaded.ok) return loaded.result;
    for (const reference of validated.refs) {
      const entry = loaded.manifest.documents[reference.logical_id];
      if (!entry || entry.document_type !== reference.document_type) {
        return this.#failure('invalid_request', 'reference_not_in_manifest');
      }
    }

    // An 84-bit digest fits exactly into 17 base36 characters. Keeping the
    // generated logical ID below the 20-character opaque-token threshold
    // avoids a caller-controlled high-entropy metadata bypass.
    const sessionDigest = BigInt(`0x${sha256(request.session.session_id).slice(0, 21)}`)
      .toString(36)
      .padStart(17, '0');
    const sessionLogicalId = `s-${sessionDigest}`;
    const referenceBullets = validated.refs.map((reference) => {
      const entry = loaded.manifest.documents[reference.logical_id];
      // The structured `references` field below retains the exact logical
      // identifier.  Do not repeat it in prose: a slash-delimited logical ID
      // can resemble an opaque credential to the submission safety scanner.
      return `A referenced ${reference.document_type} is ${entry.status} at revision ${entry.revision}.`;
    });
    const referenceSections = [];
    for (let offset = 0; offset < referenceBullets.length; offset += 30) {
      referenceSections.push({
        heading: 'Referenced document progress',
        paragraphs: [],
        bullets: referenceBullets.slice(offset, offset + 30),
        files: [],
        implementation_specs: [],
        commands: []
      });
    }
    const existingSession = loaded.manifest.documents[sessionLogicalId];
    const sessionMutation = {
      operation: existingSession ? 'update' : 'create',
      document_type: 'session',
      logical_id: sessionLogicalId,
      base_revision: existingSession?.revision ?? 0,
      content_kind: 'document',
      content: {
        schema_version: 1,
        format: 'safe-document',
        title: 'Session record',
        sections: [{
          heading: 'Session summary',
          paragraphs: ['A Horspowers session record was prepared for review.'],
          bullets: [
            `Ended at: ${request.session.ended_at}`,
            `Branch: ${request.session.branch}`
          ],
          files: [],
          implementation_specs: [],
          commands: []
        }, ...referenceSections],
        references: validated.refs
      }
    };
    const mutations = [sessionMutation];
    for (const reference of validated.refs) {
      const entry = loaded.manifest.documents[reference.logical_id];
      if (entry.status === 'archived') {
        return this.#failure('invalid_request', 'session_reference_archived');
      }
      const verified = await this.#verifyEntryBody(entry);
      if (!verified.ok) return verified.result;
      const parsed = parseCanonicalSafeDocument(verified.body);
      if (!parsed.ok) return this.#failure('safe_document_required', 'session_reference_not_safely_rewritable');
      const progressContent = {
        ...parsed.document,
        sections: [...parsed.document.sections, {
          heading: 'Session progress',
          paragraphs: ['A session progress update was prepared for review.'],
          bullets: [
            `Ended at: ${request.session.ended_at}`,
            `Branch: ${request.session.branch}`
          ],
          files: [],
          implementation_specs: [],
          commands: []
        }]
      };
      const updateIndex = mutations.length;
      mutations.push({
        operation: 'update',
        document_type: entry.document_type,
        logical_id: reference.logical_id,
        base_revision: entry.revision,
        content_kind: 'document',
        content: progressContent
      });
      if (request.auto_archive_completed === true && entry.status === 'completed') {
        mutations.push({
          operation: 'archive',
          mutation: {
            document_type: entry.document_type,
            logical_id: reference.logical_id,
            base_revision: entry.revision + 1,
            content_kind: 'status-transition',
            content: {
              uri: entry.uri,
              content_sha256: entry.content_sha256,
              from_status: entry.status,
              to_status: 'archived'
            }
          },
          depends_on: updateIndex
        });
      }
    }
    return this.mutateBatch(mutations, options);
  }

  async execute(action, request = {}, options = {}) {
    switch (action) {
      case 'get': return this.get(request);
      case 'search': return this.search(request);
      case 'create': return this.create(request, options);
      case 'update': return this.update(request, options);
      case 'archive': return this.archive(request, options);
      case 'restore': return this.restore(request, options);
      case 'config-change': return this.configChange(request, options);
      case 'record-session': return this.recordSession(request, options);
      default: return this.#failure('invalid_request', 'action_not_supported');
    }
  }
}
