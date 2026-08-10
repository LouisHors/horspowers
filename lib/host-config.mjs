import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';

const MAX_BYTES = 262_144;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SSH_ALIAS_PATTERN = /^(?!-)[A-Za-z0-9._-]{1,64}$/u;

function error(pathname, code) {
  return { path: pathname, code };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateObject(value, pathname, allowedKeys, errors) {
  if (!isPlainObject(value)) {
    errors.push(error(pathname, 'object_required'));
    return null;
  }

  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) errors.push(error(`${pathname}.${key}`, 'unknown_field'));
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) errors.push(error(`${pathname}.${key}`, 'required'));
  }
  return value;
}

function validateInteger(value, pathname, minimum, maximum, errors) {
  if (!Number.isSafeInteger(value)) {
    errors.push(error(pathname, 'integer_required'));
    return false;
  }
  if (value < minimum || value > maximum) {
    errors.push(error(pathname, 'out_of_range'));
    return false;
  }
  return true;
}

function isUriInCollection(value, collection) {
  if (typeof value !== 'string' || !COLLECTION_PATTERN.test(collection) || value.includes('\0') || /\s/u.test(value)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'qmd:' || parsed.hostname !== collection || parsed.username || parsed.password ||
      parsed.port || parsed.search || parsed.hash) {
    return false;
  }
  const prefix = `qmd://${collection}/`;
  if (!value.startsWith(prefix)) return false;

  const relativePath = value.slice(prefix.length);
  if (!relativePath || relativePath.includes('?') || relativePath.includes('#') || relativePath.includes('\\')) return false;

  return relativePath.split('/').every((segment) => {
    if (!segment || segment === '.' || segment === '..') return false;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\\') && !decoded.includes('\0');
    } catch {
      return false;
    }
  });
}

function normalizeConfig(value) {
  return {
    schema_version: value.schema_version,
    wiki: {
      transport: {
        kind: value.wiki.transport.kind,
        ssh_alias: value.wiki.transport.ssh_alias,
        timeout_ms: value.wiki.transport.timeout_ms,
        max_response_bytes: value.wiki.transport.max_response_bytes
      },
      collection: value.wiki.collection,
      registry_uri: value.wiki.registry_uri,
      inbox: {
        command: value.wiki.inbox.command,
        timeout_ms: value.wiki.inbox.timeout_ms,
        max_payload_bytes: value.wiki.inbox.max_payload_bytes
      }
    }
  };
}

/**
 * Return the conventional host-only configuration location. This helper does
 * not create the directory or file.
 * @param {string} homeDir
 * @returns {string}
 */
export function defaultHostConfigPath(homeDir) {
  return path.join(homeDir, '.config', 'horspowers', 'host.json');
}

/**
 * Strictly validate the bounded host bootstrap contract.
 * @param {unknown} value
 * @returns {{ok: true, config: Object} | {ok: false, error_code: string, errors: Array<{path: string, code: string}>}}
 */
export function validateHostConfig(value) {
  const errors = [];
  const root = validateObject(value, '$', ['schema_version', 'wiki'], errors);
  if (!root) return { ok: false, error_code: 'host_config_invalid', errors };

  if (root.schema_version !== 1) errors.push(error('$.schema_version', 'unsupported_version'));

  const wiki = validateObject(
    root.wiki,
    '$.wiki',
    ['transport', 'collection', 'registry_uri', 'inbox'],
    errors
  );

  let transport = null;
  let inbox = null;
  if (wiki) {
    transport = validateObject(
      wiki.transport,
      '$.wiki.transport',
      ['kind', 'ssh_alias', 'timeout_ms', 'max_response_bytes'],
      errors
    );
    inbox = validateObject(
      wiki.inbox,
      '$.wiki.inbox',
      ['command', 'timeout_ms', 'max_payload_bytes'],
      errors
    );

    if (typeof wiki.collection !== 'string' || !COLLECTION_PATTERN.test(wiki.collection)) {
      errors.push(error('$.wiki.collection', 'invalid_collection'));
    }
    if (!isUriInCollection(wiki.registry_uri, wiki.collection)) {
      errors.push(error('$.wiki.registry_uri', 'uri_outside_collection'));
    }
  }

  if (transport) {
    if (transport.kind !== 'ssh-stdio-mcp') errors.push(error('$.wiki.transport.kind', 'unsupported_transport'));
    if (typeof transport.ssh_alias !== 'string' || !SSH_ALIAS_PATTERN.test(transport.ssh_alias)) {
      errors.push(error('$.wiki.transport.ssh_alias', 'invalid_ssh_alias'));
    }
    validateInteger(transport.timeout_ms, '$.wiki.transport.timeout_ms', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, errors);
    validateInteger(transport.max_response_bytes, '$.wiki.transport.max_response_bytes', 1, MAX_BYTES, errors);
  }

  if (inbox) {
    if (typeof inbox.command !== 'string' || inbox.command.includes('\0') || !path.isAbsolute(inbox.command)) {
      errors.push(error('$.wiki.inbox.command', 'absolute_path_required'));
    }
    validateInteger(inbox.timeout_ms, '$.wiki.inbox.timeout_ms', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, errors);
    validateInteger(inbox.max_payload_bytes, '$.wiki.inbox.max_payload_bytes', 1, MAX_BYTES, errors);
  }

  if (errors.length > 0) return { ok: false, error_code: 'host_config_invalid', errors };
  return { ok: true, config: normalizeConfig(root) };
}

/**
 * Read and validate an explicit host configuration without mutating the host.
 * @param {string} configPath
 * @returns {Promise<{ok: true, config: Object} | {ok: false, error_code: string, errors: Array<{path: string, code: string}>}>}
 */
export async function readHostConfig(configPath) {
  let source;
  try {
    source = await readFile(configPath, 'utf8');
  } catch (readError) {
    if (readError?.code === 'ENOENT') {
      return { ok: false, error_code: 'host_config_missing', errors: [error('$', 'missing')] };
    }
    return { ok: false, error_code: 'host_config_unreadable', errors: [error('$', 'unreadable')] };
  }

  try {
    return validateHostConfig(JSON.parse(source));
  } catch {
    return { ok: false, error_code: 'host_config_invalid', errors: [error('$', 'invalid_json')] };
  }
}
