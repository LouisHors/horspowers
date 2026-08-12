#!/usr/bin/env node

import { DocumentRuntime } from './document-runtime.mjs';

const MAX_INPUT_BYTES = 256 * 1024;
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
const REQUEST_KEYS = new Set(['schema_version', 'cwd', 'action', 'request', 'confirmed']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbsoluteCwd(cwd) {
  return typeof cwd === 'string' && cwd.length > 0 && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(cwd);
}

function response(status, backend = 'disabled', projectId = null, errorCode = null) {
  return {
    status,
    backend,
    project_id: projectId,
    ...(errorCode ? { error_code: errorCode } : {})
  };
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes <= MAX_INPUT_BYTES) chunks.push(Buffer.from(chunk));
  }
  if (bytes > MAX_INPUT_BYTES) return { ok: false, error_code: 'input_too_large' };
  if (bytes === 0) return { ok: false, error_code: 'empty_input' };
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

function parseRequest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error_code: 'invalid_json' };
  }
  if (!isPlainObject(value)) return { ok: false, error_code: 'request_object_required' };
  for (const key of Object.keys(value)) {
    if (!REQUEST_KEYS.has(key)) return { ok: false, error_code: 'unknown_field' };
  }
  for (const key of REQUEST_KEYS) {
    if (!Object.hasOwn(value, key)) return { ok: false, error_code: 'required_field_missing' };
  }
  if (value.schema_version !== 1) return { ok: false, error_code: 'unsupported_schema_version' };
  if (!isAbsoluteCwd(value.cwd)) return { ok: false, error_code: 'cwd_must_be_absolute' };
  if (!ACTIONS.has(value.action)) return { ok: false, error_code: 'unknown_action' };
  if (!isPlainObject(value.request)) return { ok: false, error_code: 'request_object_required' };
  if (typeof value.confirmed !== 'boolean') return { ok: false, error_code: 'confirmed_boolean_required' };
  return { ok: true, value };
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  if (process.argv.length > 2) {
    writeJson(response('invalid_request', 'disabled', null, 'argv_not_supported'));
    return;
  }
  const input = await readStdin();
  if (!input.ok) {
    writeJson(response('invalid_request', 'disabled', null, input.error_code));
    return;
  }
  const parsed = parseRequest(input.text);
  if (!parsed.ok) {
    writeJson(response('invalid_request', 'disabled', null, parsed.error_code));
    return;
  }
  const runtime = new DocumentRuntime();
  const result = await runtime.execute(parsed.value);
  writeJson(result);
}

main().catch(() => {
  writeJson(response('runtime_unavailable', 'disabled', null, 'runtime_unavailable'));
});
