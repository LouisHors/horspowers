import { createHash } from 'node:crypto';
import { URL } from 'node:url';

const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LOGICAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const RFC3339_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;
const DOCUMENT_TYPES = new Set(['design', 'plan', 'task', 'bug', 'decision', 'context', 'config', 'session']);
const DOCUMENT_STATUSES = new Set(['active', 'completed', 'archived']);

export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_MANIFEST_DOCUMENTS = 1024;
const MAX_PROJECT_ID_BYTES = 512;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function issue(path, code) {
  return { path, code };
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

function invalid(errors, errorCode = 'manifest_invalid') {
  return { ok: false, error_code: errorCode, errors };
}

function uriSegments(value, collection) {
  if (typeof value !== 'string' || !COLLECTION_PATTERN.test(collection) ||
      value.includes('\0') || /\s/u.test(value)) {
    return null;
  }
  const prefix = `qmd://${collection}/`;
  if (!value.startsWith(prefix)) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'qmd:' || parsed.hostname !== collection || parsed.username ||
      parsed.password || parsed.port || parsed.search || parsed.hash) {
    return null;
  }

  const relativePath = value.slice(prefix.length);
  if (!relativePath || /[?#\\]/u.test(relativePath)) return null;
  const segments = relativePath.split('/');
  if (segments.some((segment) => {
    if (!segment || segment === '.' || segment === '..') return true;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..' || decoded.includes('/') ||
        decoded.includes('\\') || decoded.includes('\0');
    } catch {
      return true;
    }
  })) return null;
  return segments;
}

/**
 * Validate a qmd URI without permitting encoded traversal or a collection
 * change. The original URI text is deliberately retained for exact matching.
 * @param {unknown} value
 * @param {string} collection
 * @returns {boolean}
 */
export function isQmdUriInCollection(value, collection) {
  return uriSegments(value, collection) !== null;
}

/**
 * Require an exact URI to be a descendant of a configured project root at a
 * path-segment boundary, not merely a string prefix.
 * @param {unknown} value
 * @param {string} collection
 * @param {unknown} rootUri
 * @returns {boolean}
 */
export function isQmdUriWithinRoot(value, collection, rootUri) {
  const rootSegments = uriSegments(rootUri, collection);
  const valueSegments = uriSegments(value, collection);
  return rootSegments !== null && valueSegments !== null &&
    valueSegments.length > rootSegments.length &&
    rootSegments.every((segment, index) => valueSegments[index] === segment);
}

function expectedValues(expected) {
  const source = isPlainObject(expected?.config) ? expected.config : expected;
  const documentation = isPlainObject(source?.documentation) ? source.documentation : source;
  return {
    projectId: source?.project_id,
    fingerprint: source?.project_fingerprint,
    collection: documentation?.collection,
    rootUri: documentation?.root_uri
  };
}

function validUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = RFC3339_UTC_PATTERN.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3]) &&
    date.getUTCHours() === Number(match[4]) &&
    date.getUTCMinutes() === Number(match[5]) &&
    date.getUTCSeconds() === Number(match[6]);
}

function isOpaqueProjectId(value) {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_PROJECT_ID_BYTES && !/[\u0000-\u001F\u007F]/u.test(value);
}

/**
 * Strictly validate the immutable Wiki manifest page payload.
 * @param {unknown} value
 * @param {Object} expected
 * @returns {{ok: true, manifest: Object} | {ok: false, error_code: string, errors: Array<Object>}}
 */
export function validateWikiManifest(value, expected = {}) {
  const errors = [];
  const incompatible = [];
  const root = validateExactObject(value, '$', ['schema_version', 'project_id', 'project_fingerprint', 'documents'], errors);
  if (!root) return invalid(errors);

  if (root.schema_version !== 1) errors.push(issue('$.schema_version', 'unsupported_version'));
  if (!isOpaqueProjectId(root.project_id)) {
    errors.push(issue('$.project_id', 'invalid_project_id'));
  }
  if (typeof root.project_fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(root.project_fingerprint)) {
    errors.push(issue('$.project_fingerprint', 'invalid_fingerprint'));
  }

  const expectedValue = expectedValues(expected);
  if (!isQmdUriInCollection(expectedValue.rootUri, expectedValue.collection)) {
    errors.push(issue('$.expected.root_uri', 'invalid_expected_root'));
  }
  if (!isOpaqueProjectId(expectedValue.projectId)) {
    errors.push(issue('$.expected.project_id', 'invalid_expected_project_id'));
  }
  if (typeof expectedValue.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(expectedValue.fingerprint)) {
    errors.push(issue('$.expected.project_fingerprint', 'invalid_expected_fingerprint'));
  }
  if (root.project_id !== expectedValue.projectId) incompatible.push(issue('$.project_id', 'project_id_mismatch'));
  if (root.project_fingerprint !== expectedValue.fingerprint) incompatible.push(issue('$.project_fingerprint', 'fingerprint_mismatch'));

  if (!isPlainObject(root.documents)) {
    errors.push(issue('$.documents', 'object_required'));
  } else {
    const entries = Object.entries(root.documents);
    if (entries.length > MAX_MANIFEST_DOCUMENTS) errors.push(issue('$.documents', 'too_many_entries'));
    for (const [logicalId, document] of entries) {
      const pathname = `$.documents.${logicalId}`;
      if (!LOGICAL_ID_PATTERN.test(logicalId)) errors.push(issue(pathname, 'invalid_logical_id'));
      const entry = validateExactObject(
        document,
        pathname,
        ['document_type', 'uri', 'revision', 'status', 'content_sha256', 'updated_at'],
        errors
      );
      if (!entry) continue;
      if (typeof entry.document_type !== 'string' || !DOCUMENT_TYPES.has(entry.document_type)) {
        errors.push(issue(`${pathname}.document_type`, 'invalid_document_type'));
      }
      if (!isQmdUriWithinRoot(entry.uri, expectedValue.collection, expectedValue.rootUri)) {
        errors.push(issue(`${pathname}.uri`, 'uri_outside_root'));
      }
      if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
        errors.push(issue(`${pathname}.revision`, 'positive_integer_required'));
      }
      if (typeof entry.status !== 'string' || !DOCUMENT_STATUSES.has(entry.status)) {
        errors.push(issue(`${pathname}.status`, 'invalid_status'));
      }
      if (typeof entry.content_sha256 !== 'string' || !SHA256_PATTERN.test(entry.content_sha256)) {
        errors.push(issue(`${pathname}.content_sha256`, 'invalid_sha256'));
      }
      if (!validUtcTimestamp(entry.updated_at)) errors.push(issue(`${pathname}.updated_at`, 'invalid_utc_rfc3339'));
    }
  }

  if (errors.length > 0) return invalid(errors);
  if (incompatible.length > 0) return invalid(incompatible, 'manifest_incompatible');
  return { ok: true, manifest: value };
}

/**
 * Check the fixed configuration entry against the exact config page bytes.
 * @param {Object} manifest
 * @param {{config_uri: string, config_page: string}} expected
 * @returns {{ok: true, entry: Object, revision: number} | {ok: false, error_code: string, errors: Array<Object>}}
 */
export function validateConfigManifestEntry(manifest, expected = {}) {
  const errors = [];
  const entry = manifest?.documents?.['horspowers-config'];
  if (!isPlainObject(entry)) {
    errors.push(issue('$.documents.horspowers-config', 'required'));
  } else {
    if (entry.document_type !== 'config') errors.push(issue('$.documents.horspowers-config.document_type', 'config_required'));
    if (entry.status !== 'active') errors.push(issue('$.documents.horspowers-config.status', 'active_required'));
    if (entry.uri !== expected.config_uri) errors.push(issue('$.documents.horspowers-config.uri', 'config_uri_mismatch'));
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
      errors.push(issue('$.documents.horspowers-config.revision', 'positive_integer_required'));
    }
    const actualHash = typeof expected.config_page === 'string'
      ? createHash('sha256').update(expected.config_page, 'utf8').digest('hex')
      : null;
    if (actualHash === null || entry.content_sha256 !== actualHash) {
      errors.push(issue('$.documents.horspowers-config.content_sha256', 'config_page_hash_mismatch'));
    }
  }
  if (errors.length > 0) return invalid(errors, 'config_manifest_mismatch');
  return { ok: true, entry, revision: entry.revision };
}

export const validateManifest = validateWikiManifest;
