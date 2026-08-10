import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const LOGICAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const MAX_RECEIVER_BYTES = 256 * 1024;
const DOCUMENT_TYPES = new Set(['design', 'plan', 'task', 'bug', 'decision', 'context', 'config', 'session']);
const OPERATIONS = new Set(['create', 'update', 'archive', 'restore', 'config-change']);
const METADATA_KEYS = [
  'schema_version',
  'submission_id',
  'source',
  'project_id',
  'project_fingerprint',
  'document_type',
  'logical_id',
  'operation',
  'base_revision',
  'proposed_revision',
  'status'
];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validSubmitterConfig(value) {
  return isPlainObject(value) && typeof value.command === 'string' && path.isAbsolute(value.command) &&
    !value.command.includes('\0') && Number.isSafeInteger(value.timeoutMs) && value.timeoutMs > 0 &&
    Number.isSafeInteger(value.maxPayloadBytes) && value.maxPayloadBytes > 0 &&
    value.maxPayloadBytes <= MAX_RECEIVER_BYTES;
}

function exactMetadata(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === METADATA_KEYS.length && keys.every(key => METADATA_KEYS.includes(key)) &&
    METADATA_KEYS.every(key => Object.hasOwn(value, key));
}

function validMetadata(value) {
  if (!exactMetadata(value) || value.schema_version !== 1 || !UUID_PATTERN.test(value.submission_id) ||
      value.source !== 'Ugreen-jump-base' || typeof value.project_id !== 'string' || value.project_id.length < 1 ||
      Buffer.byteLength(value.project_id, 'utf8') > 512 || /[\u0000-\u001F\u007F]/u.test(value.project_id) ||
      typeof value.project_fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(value.project_fingerprint) ||
      typeof value.document_type !== 'string' || !DOCUMENT_TYPES.has(value.document_type) ||
      typeof value.logical_id !== 'string' || !LOGICAL_ID_PATTERN.test(value.logical_id) ||
      typeof value.operation !== 'string' || !OPERATIONS.has(value.operation) ||
      !Number.isSafeInteger(value.base_revision) || !Number.isSafeInteger(value.proposed_revision) ||
      value.proposed_revision !== value.base_revision + 1 || value.status !== 'pending-review') return false;

  if (value.operation === 'create') {
    return value.base_revision === 0 && value.document_type !== 'config';
  }
  if (value.operation === 'config-change') {
    return value.base_revision >= 1 && value.document_type === 'config' && value.logical_id === 'horspowers-config';
  }
  if (value.operation === 'archive' || value.operation === 'restore') {
    return value.base_revision >= 1 && value.document_type !== 'config';
  }
  return value.base_revision >= 1 && value.document_type !== 'config';
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function fail(errorCode) {
  return { ok: false, error_code: errorCode };
}

export function createSubmissionId() {
  return randomUUID();
}

export function filenameForSubmission(submissionId, now = new Date()) {
  if (!UUID_PATTERN.test(submissionId) || !(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('invalid submission filename input');
  }
  const timestamp = `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}` +
    `T${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}${pad(now.getUTCMilliseconds(), 3)}Z`;
  return `${timestamp}-${submissionId}.md`;
}

/**
 * Render the receiver payload. It deliberately has no frontmatter: the
 * receiver owns Inbox filesystem placement and any frontmatter it adds.
 */
export function renderInboxSubmission({ metadata, proposedDocument } = {}) {
  if (!validMetadata(metadata) || typeof proposedDocument !== 'string' ||
      proposedDocument.includes('horspowers-submission:start') ||
      proposedDocument.includes('horspowers-submission:end') || /^(?:---\r?\n)/u.test(proposedDocument)) {
    throw new TypeError('invalid inbox submission payload');
  }
  const document = proposedDocument.endsWith('\n') ? proposedDocument : `${proposedDocument}\n`;
  return '# Horspowers Inbox Submission\n\n' +
    '<!-- horspowers-submission:start -->\n' +
    '```json\n' + JSON.stringify(metadata, null, 2) + '\n```\n' +
    '<!-- horspowers-submission:end -->\n\n' +
    '## Proposed document\n\n' + document;
}

/**
 * Submit exactly one already-rendered Inbox payload through a fixed command.
 * Neither child output nor request content is surfaced in errors.
 */
export class InboxSubmitter {
  constructor({ command, timeoutMs, maxPayloadBytes } = {}, { spawnImpl = spawn, now = () => new Date() } = {}) {
    this.config = { command, timeoutMs, maxPayloadBytes };
    this.spawnImpl = spawnImpl;
    this.now = now;
  }

  async submit({ submissionId, payload } = {}) {
    if (!validSubmitterConfig(this.config)) return fail('inbox_invalid_config');
    if (!UUID_PATTERN.test(submissionId) || typeof payload !== 'string') return fail('inbox_invalid_request');
    if (Buffer.byteLength(payload, 'utf8') > this.config.maxPayloadBytes) return fail('inbox_payload_too_large');

    let filename;
    try {
      filename = filenameForSubmission(submissionId, this.now());
    } catch {
      return fail('inbox_invalid_request');
    }

    let child;
    try {
      child = this.spawnImpl(this.config.command, [filename], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      return fail('inbox_spawn_failed');
    }
    if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.stdin.write !== 'function' ||
        typeof child.stdin.end !== 'function') {
      return fail('inbox_spawn_failed');
    }

    return new Promise((resolve) => {
      let settled = false;
      let outputBytes = 0;
      let stdinEnded = false;
      let timer;
      const settle = (result, terminate = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (terminate) {
          try {
            child.kill('SIGTERM');
          } catch {
            // A failed child is already represented by the stable result.
          }
        }
        resolve(result);
      };
      const responseChunk = (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_RECEIVER_BYTES) settle(fail('inbox_response_too_large'), true);
      };
      const finishInput = () => {
        if (settled || stdinEnded) return;
        stdinEnded = true;
        try {
          child.stdin.end();
        } catch {
          settle(fail('inbox_write_failed'), true);
        }
      };

      child.stdout.on('data', responseChunk);
      child.stderr.on('data', responseChunk);
      child.stdout.once('error', () => settle(fail('inbox_connection_closed'), true));
      child.stderr.once('error', () => settle(fail('inbox_connection_closed'), true));
      child.stdin.once('error', () => settle(fail('inbox_write_failed'), true));
      child.once('error', () => settle(fail('inbox_spawn_failed'), true));
      child.once('close', (code) => {
        if (settled) return;
        if (!stdinEnded) settle(fail('inbox_connection_closed'));
        else if (code === 0) settle({ ok: true, submission_id: submissionId, filename });
        else settle(fail('inbox_process_exit'));
      });

      timer = setTimeout(() => settle(fail('inbox_timeout'), true), this.config.timeoutMs);
      try {
        let waitingForDrain = false;
        let drainSeen = false;
        const onDrain = () => {
          drainSeen = true;
          if (waitingForDrain) finishInput();
        };
        child.stdin.once('drain', onDrain);
        const accepted = child.stdin.write(Buffer.from(payload, 'utf8'));
        if (accepted === false) {
          waitingForDrain = true;
          if (drainSeen) finishInput();
        } else {
          child.stdin.removeListener?.('drain', onDrain);
          finishInput();
        }
      } catch {
        settle(fail('inbox_write_failed'), true);
      }
    });
  }
}
