import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { DocumentRuntime } from '../../lib/document-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliPath = path.join(repoRoot, 'lib/document-runtime-cli.mjs');
const MAX_INPUT_BYTES = 256 * 1024;

function runCli(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath], {
      cwd: repoRoot,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.once('close', code => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  });
}

function validRequest(overrides = {}) {
  return {
    schema_version: 1,
    cwd: repoRoot,
    action: 'resolve',
    request: {},
    confirmed: false,
    ...overrides
  };
}

function oneJsonObject(output) {
  const lines = output.trim().split('\n');
  assert.equal(lines.length, 1, `stdout must contain exactly one JSON object: ${output}`);
  return JSON.parse(lines[0]);
}

test('accepts a valid stdin request and writes exactly one JSON result to stdout', async () => {
  const result = await runCli(validRequest());

  assert.equal(result.code, 0);
  const payload = oneJsonObject(result.stdout);
  assert.equal(typeof payload.status, 'string');
  assert.equal(typeof payload.backend, 'string');
  assert.ok(Object.hasOwn(payload, 'project_id'));
  assert.equal(result.stderr, '');
});

test('rejects unknown top-level fields without emitting a second stdout value', async () => {
  const result = await runCli(validRequest({ unexpected: true }));

  assert.equal(result.code, 0);
  const payload = oneJsonObject(result.stdout);
  assert.equal(payload.status, 'invalid_request');
  assert.equal(payload.error_code, 'unknown_field');
  assert.equal(result.stderr, '');
});

test('rejects a relative cwd before resolving a project', async () => {
  const result = await runCli(validRequest({ cwd: 'relative/project' }));

  assert.equal(result.code, 0);
  const payload = oneJsonObject(result.stdout);
  assert.equal(payload.status, 'invalid_request');
  assert.equal(payload.error_code, 'cwd_must_be_absolute');
});

test('rejects stdin payloads over 256 KiB', async () => {
  const oversized = 'x'.repeat(MAX_INPUT_BYTES + 1);
  const result = await runCli(oversized);

  assert.equal(result.code, 0);
  const payload = oneJsonObject(result.stdout);
  assert.equal(payload.status, 'invalid_request');
  assert.equal(payload.error_code, 'input_too_large');
  assert.equal(result.stderr, '');
});

test('rejects unknown actions and a missing object request', async () => {
  const unknownAction = await runCli(validRequest({ action: 'delete' }));
  assert.equal(unknownAction.code, 0);
  assert.equal(oneJsonObject(unknownAction.stdout).error_code, 'unknown_action');

  const emptyRequest = await runCli(validRequest({ request: null }));
  assert.equal(emptyRequest.code, 0);
  assert.equal(oneJsonObject(emptyRequest.stdout).error_code, 'request_object_required');
});

test('never sends submitted body content to stderr or argv-derived diagnostics', async () => {
  const secretMarker = 'BODY_MUST_NOT_APPEAR_IN_STDERR_6c66d21c';
  const result = await runCli(validRequest({ unexpected_body: secretMarker }));

  assert.equal(result.code, 0);
  assert.equal(result.stderr.includes(secretMarker), false);
  assert.equal(result.stdout.includes(secretMarker), false);
  assert.equal(oneJsonObject(result.stdout).error_code, 'unknown_field');
});

test('resolving a local runtime does not construct a docs backend or initialize docs', async () => {
  let constructed = 0;
  const runtime = new DocumentRuntime({
    resolveProjectContext: async () => ({
      status: 'ready',
      project: {
        root: '/retained-fixture/local-project',
        project_id: 'fixture/local-runtime',
        identity_status: 'external'
      },
      config: { source: 'local', value: {} },
      config_status: 'valid',
      documentation: { enabled: true, backend: 'local' }
    }),
    LocalDocsBackend: class {
      constructor() {
        constructed += 1;
      }
    }
  });

  const result = await runtime.resolve('/retained-fixture/local-project');

  assert.deepEqual(result, {
    status: 'ready',
    backend: 'local',
    project_id: 'fixture/local-runtime',
    identity_status: 'external',
    config_source: 'local',
    config_status: 'valid',
    documentation_enabled: true
  });
  assert.equal(constructed, 0);
});

test('resolve exposes safe unavailable external documentation state without a local fallback', async () => {
  const runtime = new DocumentRuntime({
    resolveProjectContext: async () => ({
      status: 'unregistered_company_project',
      project: {
        root: '/retained-fixture/company-project',
        project_id: null,
        identity_status: 'company'
      },
      config: { source: 'none', value: null },
      config_status: 'unregistered',
      documentation: { enabled: false, backend: 'disabled' }
    })
  });

  const result = await runtime.resolve('/retained-fixture/company-project');

  assert.deepEqual(result, {
    status: 'unregistered_company_project',
    backend: 'disabled',
    project_id: null,
    error_code: 'unregistered_company_project',
    identity_status: 'company',
    config_source: 'none',
    config_status: 'unregistered',
    documentation_enabled: false
  });
});

test('normalizes an unknown project-context status to a documented unavailable runtime result', async () => {
  const runtime = new DocumentRuntime({
    resolveProjectContext: async () => ({
      status: 'future_context_status',
      project: {
        root: '/retained-fixture/company-project',
        project_id: 'fixture/company-runtime',
        identity_status: 'company'
      },
      config: { source: 'wiki', value: null },
      config_status: 'unavailable',
      documentation: { enabled: false, backend: 'disabled' }
    })
  });

  const result = await runtime.resolve('/retained-fixture/company-project');

  assert.equal(result.status, 'context_unavailable');
  assert.equal(result.backend, 'disabled');
  assert.equal(result.error_code, 'context_status_unrecognized');
  assert.equal(result.project_id, 'fixture/company-runtime');
  assert.equal(result.identity_status, 'company');
});

test('Wiki contexts construct only the Wiki backend and keep unavailable contexts fail closed', async () => {
  let localConstructed = 0;
  let wikiOptions = null;
  const localBackend = class {
    constructor() {
      localConstructed += 1;
    }
  };
  const qmdClient = { getExact: async () => ({ ok: false }) };
  const hostConfig = {
    wiki: {
      collection: 'my-code-wiki',
      inbox: {
        command: '/retained-fixture/wiki-inbox-submit',
        timeout_ms: 1_000,
        max_payload_bytes: 256 * 1024
      }
    }
  };
  const wikiRuntime = new DocumentRuntime({
    resolveProjectContext: async () => ({
      status: 'ready',
      project: { root: '/retained-fixture/company-project', project_id: 'fixture/company-runtime' },
      config: {
        source: 'wiki',
        value: {
          project_id: 'fixture/company-runtime',
          documentation: { collection: 'my-code-wiki' }
        }
      },
      documentation: { enabled: true, backend: 'wiki' },
      wiki: {
        config_uri: 'qmd://my-code-wiki/projects/company/horspowers-config.md',
        host_config: hostConfig,
        qmd_client: qmdClient
      }
    }),
    LocalDocsBackend: localBackend,
    InboxSubmitter: class {
      constructor(options) {
        wikiOptions = { ...(wikiOptions ?? {}), inbox: options };
      }
    },
    WikiDocsBackend: class {
      constructor(options) {
        wikiOptions = { ...(wikiOptions ?? {}), backend: options };
      }

      async execute(action, request, options) {
        return {
          status: 'ok',
          backend: 'wiki',
          project_id: 'fixture/company-runtime',
          action,
          request,
          confirmed: options.confirmed
        };
      }
    }
  });
  const unavailableRuntime = new DocumentRuntime({
    resolveProjectContext: async () => ({
      status: 'wiki_unavailable',
      project: { root: '/retained-fixture/company-project', project_id: 'fixture/company-runtime' },
      documentation: { enabled: false, backend: 'disabled' }
    }),
    LocalDocsBackend: localBackend
  });

  const wikiResult = await wikiRuntime.execute({
    cwd: '/retained-fixture/company-project', action: 'get', request: {}, confirmed: false
  });
  const unavailableResult = await unavailableRuntime.execute({
    cwd: '/retained-fixture/company-project', action: 'get', request: {}, confirmed: false
  });

  assert.equal(wikiResult.status, 'ok');
  assert.equal(wikiResult.backend, 'wiki');
  assert.equal(wikiResult.confirmed, false);
  assert.equal(wikiOptions.backend.projectRoot, '/retained-fixture/company-project');
  assert.equal(wikiOptions.backend.projectId, 'fixture/company-runtime');
  assert.equal(wikiOptions.backend.configUri, 'qmd://my-code-wiki/projects/company/horspowers-config.md');
  assert.equal(wikiOptions.backend.hostConfig, hostConfig);
  assert.equal(wikiOptions.backend.qmdClient, qmdClient);
  assert.equal(wikiOptions.inbox.command, '/retained-fixture/wiki-inbox-submit');
  assert.equal(wikiOptions.inbox.timeoutMs, 1_000);
  assert.equal(wikiOptions.inbox.maxPayloadBytes, 256 * 1024);
  assert.equal(unavailableResult.status, 'wiki_unavailable');
  assert.equal(unavailableResult.backend, 'disabled');
  assert.equal(localConstructed, 0);
});
