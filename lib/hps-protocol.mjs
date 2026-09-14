import {
  HPS_ERROR_CATALOG, HPS_OPERATION_DEFINITIONS, HPS_OPERATION_NAMES, HpsError,
  catalogErrorCode, isSafeAbsolutePath, validateOperationInput
} from './hps-operations.mjs';

export { isSafeAbsolutePath };

export const HPS_SCHEMA_VERSION = 1;
export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_REQUEST_ID_BYTES = 256;
export const MAX_OPERATION_BYTES = 96;
export const MAX_PHASE_BYTES = 96;

export const OPERATIONS = new Set(HPS_OPERATION_NAMES);

const REQUEST_KEYS = new Set(['schema_version', 'request_id', 'operation', 'cwd', 'input']);
const ERROR_CATEGORIES = new Set(['validation', 'routing', 'runtime', 'permission', 'conflict', 'transport', 'internal']);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function byteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function assertString(value, name, maxBytes) {
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > maxBytes) {
    throw new TypeError(`${name} is invalid or too large`);
  }
}

export function parseCallRequest(value) {
  if (!plainObject(value)) throw new TypeError('call request must be a JSON object');
  const keys = Object.keys(value);
  if (keys.some((key) => !REQUEST_KEYS.has(key))) throw new TypeError('unknown request field');
  if (keys.length !== REQUEST_KEYS.size) throw new TypeError('required request field missing');
  if (value.schema_version !== HPS_SCHEMA_VERSION) throw new TypeError('unsupported schema_version');
  assertString(value.request_id, 'request_id', MAX_REQUEST_ID_BYTES);
  assertString(value.operation, 'operation', MAX_OPERATION_BYTES);
  if (!OPERATIONS.has(value.operation)) {
    throw new HpsError('operation_not_found', {
      category: 'routing', requiredAction: 'use_supported_operation'
    });
  }
  if (!isSafeAbsolutePath(value.cwd)) throw new TypeError('cwd must be absolute and safe');
  if (!plainObject(value.input)) throw new TypeError('input must be a JSON object');
  if (!HPS_OPERATION_DEFINITIONS[value.operation].deferred) {
    validateOperationInput(value.operation, value.input, { cwd: value.cwd });
  }
  return value;
}

function safeMetrics(metrics) {
  if (!plainObject(metrics)) return {};
  return Object.fromEntries(Object.entries(metrics).filter(([key, value]) =>
    /^[a-z][a-z0-9_]{0,63}$/u.test(key) && (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
  ));
}

export function createResult(request, result = null, metrics = {}) {
  return {
    schema_version: HPS_SCHEMA_VERSION,
    request_id: request?.request_id ?? null,
    status: 'ok',
    result,
    error: null,
    metrics: safeMetrics(metrics)
  };
}

export function createError(request, code, _message, options = {}) {
  const safeCode = catalogErrorCode(code);
  const catalog = HPS_ERROR_CATALOG[safeCode];
  return {
    schema_version: HPS_SCHEMA_VERSION,
    request_id: request?.request_id ?? null,
    status: 'error',
    result: null,
    error: {
      code: safeCode,
      category: ERROR_CATEGORIES.has(catalog.category) ? catalog.category : 'runtime',
      retryable: catalog.retryable === true,
      required_action: catalog.requiredAction,
      message: safeCode
    },
    metrics: safeMetrics(options.metrics)
  };
}

export function progressEvent(request, phase, status, metrics = {}) {
  assertString(phase, 'phase', MAX_PHASE_BYTES);
  assertString(status, 'status', MAX_PHASE_BYTES);
  return {
    schema_version: HPS_SCHEMA_VERSION,
    request_id: request?.request_id ?? null,
    phase,
    status,
    metrics: safeMetrics(metrics)
  };
}

export function serializedSize(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
