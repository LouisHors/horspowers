import test from 'node:test';
import assert from 'node:assert/strict';

import { call } from '../../lib/hps-cli.mjs';
import { HpsMcpServer } from '../../lib/hps-mcp-server.mjs';
import { HpsError } from '../../lib/hps-operations.mjs';

function request(id, method, params = {}) {
  return { jsonrpc: '2.0', id, method, params };
}

async function initializedServer(runtime) {
  const server = new HpsMcpServer({ runtime });
  await server.handle(request('init', 'initialize', { protocolVersion: '2025-06-18' }));
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  return server;
}

test('CLI and MCP use one canonical envelope for the same successful operation', async () => {
  const runtime = { runtimeDoctor: async () => ({ capabilities: { workspace_read: true }, metrics: { probe_ms: 2 } }) };
  const payload = {
    schema_version: 1,
    request_id: 'same-id',
    operation: 'runtime_doctor',
    cwd: '/repo',
    input: {}
  };

  const cli = await call(JSON.stringify(payload), runtime);
  const server = await initializedServer(runtime);
  const mcp = await server.handle(request('same-id', 'tools/call', {
    name: 'runtime_doctor',
    arguments: { cwd: '/repo', input: {} }
  }));

  assert.equal(mcp.result.isError, false);
  assert.deepEqual(mcp.result.structuredContent, cli);
  assert.deepEqual(JSON.parse(mcp.result.content[0].text), cli);
});

test('CLI and MCP preserve stable runtime error codes', async () => {
  const runtime = { documentRead: async () => { throw new Error('scope_expired'); } };
  const payload = {
    schema_version: 1,
    request_id: 'expired-id',
    operation: 'document_get',
    cwd: '/repo',
    input: { scope_id: 'scope-a', logical_id: 'plan-a' }
  };

  const cli = await call(JSON.stringify(payload), runtime);
  const server = await initializedServer(runtime);
  const mcp = await server.handle(request('expired-id', 'tools/call', {
    name: 'document_get',
    arguments: { cwd: '/repo', input: payload.input }
  }));

  assert.equal(cli.error.code, 'scope_expired');
  assert.equal(mcp.result.isError, true);
  assert.deepEqual(mcp.result.structuredContent, cli);
});

test('CLI and MCP replace unknown HpsError metadata with the safe runtime catalog entry', async () => {
  const runtime = {
    runtimeDoctor: async () => {
      throw new HpsError('secret-token-never-echo', {
        category: 'internal', requiredAction: 'leak-secret'
      });
    }
  };
  const payload = {
    schema_version: 1,
    request_id: 'unknown-runtime-error',
    operation: 'runtime_doctor',
    cwd: '/repo',
    input: {}
  };

  const cli = await call(JSON.stringify(payload), runtime);
  const server = await initializedServer(runtime);
  const mcp = await server.handle(request(payload.request_id, 'tools/call', {
    name: payload.operation,
    arguments: { cwd: payload.cwd, input: payload.input }
  }));

  assert.deepEqual(cli.error, {
    code: 'runtime_error', category: 'runtime', retryable: true,
    required_action: 'inspect_metrics', message: 'runtime_error'
  });
  assert.deepEqual(mcp.result.structuredContent, cli);
  assert.doesNotMatch(JSON.stringify({ cli, mcp }), /secret-token|internal|leak-secret/iu);
});

test('allowlisted HpsError codes use canonical catalog metadata instead of caller metadata', async () => {
  const runtime = {
    runtimeDoctor: async () => {
      throw new HpsError('invalid_request', {
        category: 'internal', retryable: true, requiredAction: 'leak-secret'
      });
    }
  };
  const result = await call(JSON.stringify({
    schema_version: 1, request_id: 'catalog-metadata', operation: 'runtime_doctor', cwd: '/repo', input: {}
  }), runtime);

  assert.deepEqual(result.error, {
    code: 'invalid_request', category: 'validation', retryable: false,
    required_action: 'fix_input', message: 'invalid_request'
  });
  assert.doesNotMatch(JSON.stringify(result), /internal|leak-secret/iu);
});

test('project_snapshot success envelopes are identical across CLI and MCP', async () => {
  const result = {
    root: '/repo', config_revision: 3, manifest_revision: 4,
    remote: { status: 'known', remote_name: 'origin', host: 'ugnas-gitlab', path: 'org/repo', upstream: 'origin/main' }
  };
  const runtime = { projectSnapshot: async () => result };
  const input = { scope_id: 'scope-a' };
  const payload = { schema_version: 1, request_id: 'snapshot-ok', operation: 'project_snapshot', cwd: '/repo', input };

  const cli = await call(JSON.stringify(payload), runtime);
  const server = await initializedServer(runtime);
  const mcp = await server.handle(request('snapshot-ok', 'tools/call', {
    name: 'project_snapshot', arguments: { cwd: '/repo', input }
  }));

  assert.equal(mcp.result.isError, false);
  assert.deepEqual(mcp.result.structuredContent, cli);
});

test('project_snapshot scope errors are identical across CLI and MCP', async () => {
  const runtime = { projectSnapshot: async () => { throw new Error('scope_expired'); } };
  const input = { scope_id: 'expired-scope' };
  const payload = { schema_version: 1, request_id: 'snapshot-expired', operation: 'project_snapshot', cwd: '/repo', input };

  const cli = await call(JSON.stringify(payload), runtime);
  const server = await initializedServer(runtime);
  const mcp = await server.handle(request('snapshot-expired', 'tools/call', {
    name: 'project_snapshot', arguments: { cwd: '/repo', input }
  }));

  assert.equal(cli.error.code, 'scope_expired');
  assert.equal(mcp.result.isError, true);
  assert.deepEqual(mcp.result.structuredContent, cli);
});

test('operation inputs are strict and reject execution-boundary overrides', async () => {
  const base = {
    schema_version: 1,
    request_id: 'strict-id',
    operation: 'verification_run',
    cwd: '/repo',
    input: { profile: 'hps-unit' }
  };

  for (const input of [
    { ...base.input, unknown: true },
    { ...base.input, command: 'node' },
    { ...base.input, argv: ['--test'] },
    { ...base.input, env: { TOKEN: 'x' } },
    { ...base.input, host: 'example.invalid' }
  ]) {
    const result = await call(JSON.stringify({ ...base, input }), {});
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'invalid_request');
  }
});

test('scope-bound context and verification operations reject missing scope ids', async () => {
  for (const [operation, input] of [
    ['project_context', {}],
    ['context_collect', { query: 'runtime' }],
    ['verification_run', { profile: 'hps-unit' }]
  ]) {
    const result = await call(JSON.stringify({
      schema_version: 1, request_id: `scope-${operation}`, operation, cwd: '/repo', input
    }), {});
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'invalid_request');
  }
});

test('unknown operation is canonical and does not echo operation tokens', async () => {
  const payload = {
    schema_version: 1, request_id: 'unknown-op', operation: 'shell;token=never-echo', cwd: '/repo', input: {}
  };
  const cli = await call(JSON.stringify(payload), {});
  assert.equal(cli.error.code, 'operation_not_found');
  assert.equal(cli.error.category, 'routing');
  assert.equal(cli.error.retryable, false);
  assert.equal(cli.error.required_action, 'use_supported_operation');
  assert.equal(cli.error.message, 'operation_not_found');
  assert.doesNotMatch(JSON.stringify(cli), /shell|never-echo/iu);
});

test('deferred operation with unknown fields is canonical and equivalent in CLI and MCP', async () => {
  const payload = {
    schema_version: 1, request_id: 'deferred-unknown-fields', operation: 'project_bootstrap_submit', cwd: '/repo',
    input: { unknown: true, token: 'never-echo' }
  };
  const cli = await call(JSON.stringify(payload), {});
  const server = await initializedServer({});
  const mcp = await server.handle(request(payload.request_id, 'tools/call', {
    name: payload.operation, arguments: { cwd: payload.cwd, input: payload.input }
  }));
  assert.equal(cli.error.code, 'operation_unavailable');
  assert.equal(cli.error.message, 'operation_unavailable');
  assert.doesNotMatch(JSON.stringify(cli), /never-echo/iu);
  assert.equal(mcp.result.isError, true);
  assert.deepEqual(mcp.result.structuredContent, cli);
  assert.doesNotMatch(JSON.stringify(mcp), /never-echo/iu);
});
