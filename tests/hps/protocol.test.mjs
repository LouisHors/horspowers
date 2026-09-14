import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HPS_SCHEMA_VERSION,
  OPERATIONS,
  createError,
  createResult,
  parseCallRequest,
  progressEvent
} from '../../lib/hps-protocol.mjs';

const valid = () => ({
  schema_version: HPS_SCHEMA_VERSION,
  request_id: 'req-1',
  operation: 'task_prepare',
  cwd: '/repo',
  input: { message: 'hello' }
});

test('parses a strict call request and rejects unknown fields', () => {
  assert.deepEqual(parseCallRequest(valid()), valid());
  assert.throws(() => parseCallRequest({ ...valid(), extra: true }), /unknown|field/i);
  assert.throws(() => parseCallRequest({ ...valid(), cwd: 'relative' }), /absolute/i);
});

test('rejects unsupported operations and oversized request ids', () => {
  assert.ok(OPERATIONS.has('task_prepare'));
  assert.throws(() => parseCallRequest({ ...valid(), operation: 'shell' }), (error) => {
    assert.equal(error.code, 'operation_not_found');
    assert.doesNotMatch(error.message, /shell/iu);
    return true;
  });
  assert.throws(() => parseCallRequest({ ...valid(), request_id: 'x'.repeat(257) }), /request_id/i);
});

test('task_prepare accepts bounded collector entry paths and a safe wiki root', () => {
  assert.doesNotThrow(() => parseCallRequest({
    ...valid(), input: {
      message: 'collect context',
      known_entry_files: ['/repo/README.md', '/repo/docs/AGENTS.md'],
      wiki_root: '/Users/ugreen/hors/my-code-wiki'
    }
  }));
  assert.doesNotThrow(() => parseCallRequest({ ...valid(), input: { wiki_root: null, known_entry_files: [] } }));
  for (const input of [
    { known_entry_files: ['/repo/../../etc/passwd'] },
    { known_entry_files: ['file:///repo/README.md'] },
    { known_entry_files: ['/repo/README.md;touch /tmp/pwned'] },
    { wiki_root: 'file:///Users/ugreen/wiki', known_entry_files: [] },
    { wiki_root: '/Users/ugreen/wiki;touch /tmp/pwned', known_entry_files: [] },
    { known_entry_files: ['/repo/README.md'], wiki_root: 'relative/wiki' }
  ]) {
    assert.throws(() => parseCallRequest({ ...valid(), input }), /invalid|path|entry|wiki/iu);
  }
});

test('recognized deferred operations bypass input field validation', () => {
  assert.doesNotThrow(() => parseCallRequest({
    ...valid(), operation: 'project_bootstrap_submit', input: { unknown: 'ignored', token: 'never-echo' }
  }));
});

test('accepts Phase 2 read-only execution operations', () => {
  const inputs = {
    project_snapshot: {},
    project_context: { scope_id: 'scope-a' },
    git_preflight: {},
    diff_snapshot: {},
    document_resolve: {},
    document_search: { scope_id: 'scope-a', query: 'runtime', intent: 'find project runtime documentation' },
    document_get: { scope_id: 'scope-a', logical_id: 'plan-a' }
  };
  for (const [operation, input] of Object.entries(inputs)) {
    assert.doesNotThrow(() => parseCallRequest({ ...valid(), operation, input }));
  }
  assert.throws(() => parseCallRequest({ ...valid(), operation: 'verification_run', input: { command: 'rm -rf' } }), /invalid_request/i);
  assert.throws(() => parseCallRequest({ ...valid(), operation: 'document_search', input: { scope_id: 'scope-a', query: 'runtime' } }), /invalid_request/i);
});

test('creates stable result and error envelopes with metrics', () => {
  const result = createResult(valid(), { route: 'direct' }, { duration_ms: 3 });
  assert.deepEqual(Object.keys(result), ['schema_version', 'request_id', 'status', 'result', 'error', 'metrics']);
  assert.equal(result.status, 'ok');
  assert.equal(result.error, null);
  assert.equal(result.metrics.duration_ms, 3);

  const error = createError(valid(), 'invalid_request', 'bad input', {
    category: 'validation', retryable: false, required_action: 'fix_input'
  });
  assert.equal(error.status, 'error');
  assert.deepEqual(error.error, {
    code: 'invalid_request', category: 'validation', retryable: false,
    required_action: 'fix_input', message: 'invalid_request'
  });
});

test('createError only emits catalog codes and canonical metadata', () => {
  const unknown = createError(valid(), 'secret-code', 'never echo this', {
    category: 'internal', retryable: true, required_action: 'leak-secret'
  });
  assert.deepEqual(unknown.error, {
    code: 'runtime_error', category: 'runtime', retryable: true,
    required_action: 'inspect_metrics', message: 'runtime_error'
  });

  const known = createError(valid(), 'invalid_request', 'never echo this', {
    category: 'internal', retryable: true, required_action: 'leak-secret'
  });
  assert.deepEqual(known.error, {
    code: 'invalid_request', category: 'validation', retryable: false,
    required_action: 'fix_input', message: 'invalid_request'
  });
});

test('progress events contain no message正文 and are bounded', () => {
  const event = progressEvent(valid(), 'prepare', 'started', { elapsed_ms: 1 });
  assert.deepEqual(event, {
    schema_version: HPS_SCHEMA_VERSION,
    request_id: 'req-1', phase: 'prepare', status: 'started', metrics: { elapsed_ms: 1 }
  });
  assert.throws(() => progressEvent(valid(), 'x'.repeat(200), 'started'), /phase/i);
});
