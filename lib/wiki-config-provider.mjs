import {
  isQmdUriInCollection,
  isQmdUriWithinRoot,
  validateConfigManifestEntry,
  validateWikiManifest
} from './wiki-manifest.mjs';
import { markdownFromQmdResource } from './wiki-qmd-content.mjs';

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_MACHINE_PAGE_BYTES = 256 * 1024;
const MAX_REGISTRY_PROJECTS = 4096;
const MAX_TEXT_BYTES = 512;
const DEVELOPMENT_MODES = new Set(['personal', 'team']);
const BRANCH_STRATEGIES = new Set(['simple', 'worktree']);
const TESTING_STRATEGIES = new Set(['test-after', 'tdd']);
const COMPLETION_STRATEGIES = new Set(['merge', 'pr', 'keep']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function issue(path, code) {
  return { path, code };
}

function invalid(errors, errorCode) {
  return { ok: false, error_code: errorCode, errors };
}

function validateExactObject(value, pathname, keys, errors) {
  if (!isPlainObject(value)) {
    errors.push(issue(pathname, 'object_required'));
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push(issue(`${pathname}.${key}`, 'unknown_field'));
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) errors.push(issue(`${pathname}.${key}`, 'required'));
  }
  return value;
}

function boundedString(value, pattern) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES && pattern.test(value);
}

function isOpaqueProjectId(value) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES && !/[\u0000-\u001F\u007F]/u.test(value);
}

function countOccurrences(source, token) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(token, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + token.length;
  }
}

function skipJsonWhitespace(source, index) {
  while (index < source.length && /[\u0009\u000a\u000d\u0020]/u.test(source[index])) index += 1;
  return index;
}

function jsonStringEnd(source, start) {
  if (source[start] !== '"') return null;
  for (let index = start + 1; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 0x22) return index + 1;
    if (code === 0x5c) {
      index += 1;
      if (index >= source.length) return null;
      continue;
    }
    if (code <= 0x1f) return null;
  }
  return null;
}

function scanJsonValue(source, start) {
  let index = skipJsonWhitespace(source, start);
  const current = source[index];
  if (current === '"') {
    const end = jsonStringEnd(source, index);
    return end === null ? null : { index: end };
  }
  if (current === '{') {
    index = skipJsonWhitespace(source, index + 1);
    const keys = new Set();
    if (source[index] === '}') return { index: index + 1 };
    while (index < source.length) {
      const keyStart = index;
      const keyEnd = jsonStringEnd(source, keyStart);
      if (keyEnd === null) return null;
      let key;
      try {
        key = JSON.parse(source.slice(keyStart, keyEnd));
      } catch {
        return null;
      }
      if (keys.has(key)) return { duplicate: true };
      keys.add(key);
      index = skipJsonWhitespace(source, keyEnd);
      if (source[index] !== ':') return null;
      const value = scanJsonValue(source, index + 1);
      if (!value || value.duplicate) return value;
      index = skipJsonWhitespace(source, value.index);
      if (source[index] === '}') return { index: index + 1 };
      if (source[index] !== ',') return null;
      index = skipJsonWhitespace(source, index + 1);
    }
    return null;
  }
  if (current === '[') {
    index = skipJsonWhitespace(source, index + 1);
    if (source[index] === ']') return { index: index + 1 };
    while (index < source.length) {
      const value = scanJsonValue(source, index);
      if (!value || value.duplicate) return value;
      index = skipJsonWhitespace(source, value.index);
      if (source[index] === ']') return { index: index + 1 };
      if (source[index] !== ',') return null;
      index = skipJsonWhitespace(source, index + 1);
    }
    return null;
  }
  if (current === undefined || current === ']' || current === '}') return null;
  let end = index;
  while (end < source.length && !/[\u0009\u000a\u000d\u0020,\]}]/u.test(source[end])) end += 1;
  return end === index ? null : { index: end };
}

function containsDuplicateJsonKeys(source) {
  const scanned = scanJsonValue(source, 0);
  return scanned?.duplicate === true;
}

/**
 * Extract exactly one marker-delimited JSON code fence from a complete raw
 * Markdown page. The source is not trimmed or normalized before parsing.
 * @param {unknown} markdown
 * @param {string} markerName
 * @param {number} maxBytes
 * @returns {{ok: true, value: Object} | {ok: false, error_code: string, errors: Array<Object>}}
 */
export function extractMachineJson(markdown, markerName, maxBytes) {
  if (typeof markdown !== 'string') return invalid([issue('$', 'markdown_required')], 'machine_block_invalid');
  if (typeof markerName !== 'string' || !/^horspowers-[a-z0-9-]+$/u.test(markerName)) {
    return invalid([issue('$', 'invalid_marker_name')], 'machine_block_invalid');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return invalid([issue('$', 'invalid_max_bytes')], 'machine_block_invalid');
  }
  if (Buffer.byteLength(markdown, 'utf8') > maxBytes) {
    return invalid([issue('$', 'content_too_large')], 'machine_block_too_large');
  }

  const startMarker = `<!-- ${markerName}:start -->`;
  const endMarker = `<!-- ${markerName}:end -->`;
  const startCount = countOccurrences(markdown, startMarker);
  const endCount = countOccurrences(markdown, endMarker);
  if (startCount === 0 || endCount === 0) {
    return invalid([issue('$', 'marker_missing')], 'machine_block_missing');
  }
  if (startCount !== 1 || endCount !== 1) {
    return invalid([issue('$', 'marker_not_unique')], 'machine_block_duplicate');
  }

  const startIndex = markdown.indexOf(startMarker);
  const endIndex = markdown.indexOf(endMarker);
  if (endIndex <= startIndex) return invalid([issue('$', 'marker_order_invalid')], 'machine_block_invalid');
  const between = markdown.slice(startIndex + startMarker.length, endIndex);
  const fence = /^\r?\n```json\r?\n([\s\S]*?)\r?\n```\r?\n$/u.exec(between);
  if (!fence) return invalid([issue('$', 'json_fence_required')], 'machine_block_invalid');

  if (containsDuplicateJsonKeys(fence[1])) {
    return invalid([issue('$', 'duplicate_json_key')], 'machine_json_duplicate_key');
  }

  try {
    const value = JSON.parse(fence[1]);
    if (!isPlainObject(value)) return invalid([issue('$', 'json_object_required')], 'machine_block_invalid');
    return { ok: true, value };
  } catch {
    return invalid([issue('$', 'invalid_json')], 'machine_json_invalid');
  }
}

function collectionFromHostConfig(hostConfig) {
  const collection = hostConfig?.wiki?.collection;
  return typeof collection === 'string' && COLLECTION_PATTERN.test(collection) ? collection : null;
}

/**
 * Validate the exact Registry payload, including unknown-field rejection at
 * every object boundary.
 * @param {unknown} value
 * @param {Object} hostConfig
 * @returns {{ok: true, registry: Object} | {ok: false, error_code: string, errors: Array<Object>}}
 */
export function validateRegistry(value, hostConfig) {
  const errors = [];
  const collection = collectionFromHostConfig(hostConfig);
  if (!collection) errors.push(issue('$.host_config.wiki.collection', 'invalid_collection'));
  const root = validateExactObject(value, '$', ['schema_version', 'projects'], errors);
  if (!root) return invalid(errors, 'registry_invalid');
  if (root.schema_version !== 1) errors.push(issue('$.schema_version', 'unsupported_version'));
  if (!isPlainObject(root.projects)) {
    errors.push(issue('$.projects', 'object_required'));
  } else {
    const entries = Object.entries(root.projects);
    if (entries.length > MAX_REGISTRY_PROJECTS) errors.push(issue('$.projects', 'too_many_entries'));
    for (const [fingerprint, entryValue] of entries) {
      const pathname = `$.projects.${fingerprint}`;
      if (!FINGERPRINT_PATTERN.test(fingerprint)) errors.push(issue(pathname, 'invalid_fingerprint'));
      const entry = validateExactObject(entryValue, pathname, ['project_id', 'config_uri'], errors);
      if (!entry) continue;
      if (!isOpaqueProjectId(entry.project_id)) {
        errors.push(issue(`${pathname}.project_id`, 'invalid_project_id'));
      }
      if (!isQmdUriInCollection(entry.config_uri, collection)) {
        errors.push(issue(`${pathname}.config_uri`, 'uri_outside_collection'));
      }
    }
  }
  if (errors.length > 0) return invalid(errors, 'registry_invalid');
  return { ok: true, registry: value };
}

function expectedValues(expected) {
  const registry = isPlainObject(expected?.registry) ? expected.registry : expected;
  const identity = isPlainObject(expected?.identity) ? expected.identity : expected;
  return {
    projectId: registry?.project_id ?? expected?.project_id,
    fingerprint: identity?.project_fingerprint ?? expected?.project_fingerprint,
    configUri: registry?.config_uri ?? expected?.config_uri
  };
}

/**
 * Validate the strict company-project Wiki configuration and bind it to the
 * Registry entry and Git identity supplied by the caller.
 * @param {unknown} value
 * @param {Object} expected
 * @param {Object} hostConfig
 * @returns {{ok: true, config: Object} | {ok: false, error_code: string, errors: Array<Object>}}
 */
export function validateWikiProjectConfig(value, expected = {}, hostConfig) {
  const errors = [];
  const incompatible = [];
  const collection = collectionFromHostConfig(hostConfig);
  if (!collection) errors.push(issue('$.host_config.wiki.collection', 'invalid_collection'));
  const root = validateExactObject(
    value,
    '$',
    ['schema_version', 'project_id', 'project_fingerprint', 'development_mode', 'branch_strategy', 'testing_strategy', 'completion_strategy', 'documentation'],
    errors
  );
  if (!root) return invalid(errors, 'project_config_invalid');

  if (root.schema_version !== 1) errors.push(issue('$.schema_version', 'unsupported_version'));
  if (!isOpaqueProjectId(root.project_id)) errors.push(issue('$.project_id', 'invalid_project_id'));
  if (!boundedString(root.project_fingerprint, FINGERPRINT_PATTERN)) errors.push(issue('$.project_fingerprint', 'invalid_fingerprint'));
  if (typeof root.development_mode !== 'string' || !DEVELOPMENT_MODES.has(root.development_mode)) {
    errors.push(issue('$.development_mode', 'invalid_development_mode'));
  }
  if (typeof root.branch_strategy !== 'string' || !BRANCH_STRATEGIES.has(root.branch_strategy)) {
    errors.push(issue('$.branch_strategy', 'invalid_branch_strategy'));
  }
  if (typeof root.testing_strategy !== 'string' || !TESTING_STRATEGIES.has(root.testing_strategy)) {
    errors.push(issue('$.testing_strategy', 'invalid_testing_strategy'));
  }
  if (typeof root.completion_strategy !== 'string' || !COMPLETION_STRATEGIES.has(root.completion_strategy)) {
    errors.push(issue('$.completion_strategy', 'invalid_completion_strategy'));
  }

  const documentation = validateExactObject(
    root.documentation,
    '$.documentation',
    ['enabled', 'backend', 'collection', 'root_uri', 'manifest_uri', 'submission'],
    errors
  );
  let submission = null;
  if (documentation) {
    if (typeof documentation.enabled !== 'boolean') errors.push(issue('$.documentation.enabled', 'boolean_required'));
    if (documentation.backend !== 'wiki') errors.push(issue('$.documentation.backend', 'wiki_backend_required'));
    if (documentation.collection !== collection) incompatible.push(issue('$.documentation.collection', 'collection_mismatch'));
    if (!isQmdUriInCollection(documentation.root_uri, collection)) {
      errors.push(issue('$.documentation.root_uri', 'uri_outside_collection'));
    }
    if (!isQmdUriWithinRoot(documentation.manifest_uri, collection, documentation.root_uri)) {
      errors.push(issue('$.documentation.manifest_uri', 'uri_outside_root'));
    }
    submission = validateExactObject(documentation.submission, '$.documentation.submission', ['mode', 'auto_submit'], errors);
    if (submission) {
      if (submission.mode !== 'inbox-only') errors.push(issue('$.documentation.submission.mode', 'inbox_only_required'));
      if (typeof submission.auto_submit !== 'boolean') errors.push(issue('$.documentation.submission.auto_submit', 'boolean_required'));
    }
  }

  const expectedValue = expectedValues(expected);
  if (typeof expectedValue.projectId === 'string' && root.project_id !== expectedValue.projectId) {
    incompatible.push(issue('$.project_id', 'registry_project_id_mismatch'));
  }
  if (typeof expectedValue.fingerprint === 'string' && root.project_fingerprint !== expectedValue.fingerprint) {
    incompatible.push(issue('$.project_fingerprint', 'identity_fingerprint_mismatch'));
  }
  if (typeof expectedValue.configUri === 'string' && documentation &&
      !isQmdUriWithinRoot(expectedValue.configUri, collection, documentation.root_uri)) {
    incompatible.push(issue('$.documentation.root_uri', 'registry_config_uri_outside_root'));
  }

  if (errors.length > 0) return invalid(errors, 'project_config_invalid');
  if (incompatible.length > 0) return invalid(incompatible, 'project_config_incompatible');
  return { ok: true, config: value };
}

function markdownFromQmdResult(outcome) {
  if (!outcome || outcome.ok !== true) return null;
  const content = outcome.result?.content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const [item] = content;
  if (item?.type === 'text' && typeof item.text === 'string') return item.text;
  if (item?.type === 'resource' && typeof item.resource?.text === 'string') {
    return markdownFromQmdResource(item.resource.text);
  }
  return null;
}

async function exactPage(qmdClient, uri) {
  try {
    const outcome = await qmdClient?.getExact?.(uri);
    return markdownFromQmdResult(outcome);
  } catch {
    return null;
  }
}

function unavailable(errorCode = 'qmd_get_failed') {
  return { status: 'wiki_unavailable', error_code: errorCode };
}

/**
 * Resolve a company configuration through the fixed exact Registry -> config
 * -> manifest sequence. It intentionally has no local-config fallback and no
 * query capability.
 * @param {{identity: Object, hostConfig: Object, qmdClient: Object}} options
 * @returns {Promise<Object>}
 */
export async function resolveWikiProjectConfig({ identity, hostConfig, qmdClient } = {}) {
  const collection = collectionFromHostConfig(hostConfig);
  const registryUri = hostConfig?.wiki?.registry_uri;
  if (!collection || !isQmdUriInCollection(registryUri, collection)) return unavailable('host_config_invalid');
  if (identity?.kind !== 'company' || !FINGERPRINT_PATTERN.test(identity.project_fingerprint)) {
    return { status: 'project_config_incompatible', error_code: 'company_identity_required' };
  }

  const registryPage = await exactPage(qmdClient, registryUri);
  if (registryPage === null) return unavailable();
  const extractedRegistry = extractMachineJson(registryPage, 'horspowers-registry', MAX_MACHINE_PAGE_BYTES);
  if (!extractedRegistry.ok) {
    return {
      status: 'registry_invalid',
      error_code: extractedRegistry.error_code,
      errors: extractedRegistry.errors
    };
  }
  const validatedRegistry = validateRegistry(extractedRegistry.value, hostConfig);
  if (!validatedRegistry.ok) return { status: 'registry_invalid', error_code: validatedRegistry.error_code, errors: validatedRegistry.errors };

  const registryEntry = validatedRegistry.registry.projects[identity.project_fingerprint];
  if (!registryEntry) return { status: 'unregistered_company_project' };

  const configPage = await exactPage(qmdClient, registryEntry.config_uri);
  if (configPage === null) return unavailable();
  const extractedConfig = extractMachineJson(configPage, 'horspowers-config', MAX_MACHINE_PAGE_BYTES);
  if (!extractedConfig.ok) {
    return {
      status: 'project_config_invalid',
      error_code: extractedConfig.error_code,
      errors: extractedConfig.errors
    };
  }
  const validatedConfig = validateWikiProjectConfig(extractedConfig.value, {
    identity,
    registry: registryEntry
  }, hostConfig);
  if (!validatedConfig.ok) {
    return {
      status: validatedConfig.error_code,
      error_code: validatedConfig.error_code,
      errors: validatedConfig.errors
    };
  }

  const manifestUri = validatedConfig.config.documentation.manifest_uri;
  const manifestPage = await exactPage(qmdClient, manifestUri);
  if (manifestPage === null) return unavailable();
  const extractedManifest = extractMachineJson(manifestPage, 'horspowers-manifest', MAX_MACHINE_PAGE_BYTES);
  if (!extractedManifest.ok) {
    return {
      status: 'project_config_invalid',
      error_code: extractedManifest.error_code,
      errors: extractedManifest.errors
    };
  }
  const validatedManifest = validateWikiManifest(extractedManifest.value, validatedConfig.config);
  if (!validatedManifest.ok) {
    return {
      status: validatedManifest.error_code === 'manifest_incompatible' ? 'project_config_incompatible' : 'project_config_invalid',
      error_code: validatedManifest.error_code,
      errors: validatedManifest.errors
    };
  }
  const configManifest = validateConfigManifestEntry(validatedManifest.manifest, {
    config_uri: registryEntry.config_uri,
    config_page: configPage
  });
  if (!configManifest.ok) {
    return {
      status: 'project_config_incompatible',
      error_code: configManifest.error_code,
      errors: configManifest.errors
    };
  }

  return {
    status: 'ready',
    source: 'wiki',
    config: validatedConfig.config,
    manifest: validatedManifest.manifest,
    config_uri: registryEntry.config_uri,
    config_revision: configManifest.revision
  };
}
