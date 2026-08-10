import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  extractMachineJson,
  resolveWikiProjectConfig,
  validateRegistry,
  validateWikiProjectConfig
} from '../../lib/wiki-config-provider.mjs';

const COLLECTION = 'my-code-wiki';
const REGISTRY_URI = 'qmd://my-code-wiki/projects/horspowers-registry.md';
const ROOT_URI = 'qmd://my-code-wiki/projects/ugcli-lib';
const CONFIG_URI = `${ROOT_URI}/horspowers-config.md`;
const MANIFEST_URI = `${ROOT_URI}/index.md`;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function hostConfig() {
  return {
    schema_version: 1,
    wiki: {
      transport: {
        kind: 'ssh-stdio-mcp',
        ssh_alias: 'localwiki',
        timeout_ms: 20_000,
        max_response_bytes: 262_144
      },
      collection: COLLECTION,
      registry_uri: REGISTRY_URI,
      inbox: {
        command: '/data/horsliu/bin/wiki-inbox-submit',
        timeout_ms: 20_000,
        max_payload_bytes: 262_144
      }
    }
  };
}

function identity() {
  return {
    kind: 'company',
    project_root: '/retained-fixture/company-project',
    canonical_repository: 'ugnas-gitlab/platform/ugcli-lib',
    project_fingerprint: FINGERPRINT
  };
}

function registry() {
  return {
    schema_version: 1,
    projects: {
      [FINGERPRINT]: {
        project_id: 'ugnas/ugcli-lib',
        config_uri: CONFIG_URI
      }
    }
  };
}

function projectConfig(overrides = {}) {
  const value = {
    schema_version: 1,
    project_id: 'ugnas/ugcli-lib',
    project_fingerprint: FINGERPRINT,
    development_mode: 'team',
    branch_strategy: 'worktree',
    testing_strategy: 'tdd',
    completion_strategy: 'pr',
    documentation: {
      enabled: true,
      backend: 'wiki',
      collection: COLLECTION,
      root_uri: ROOT_URI,
      manifest_uri: MANIFEST_URI,
      submission: {
        mode: 'inbox-only',
        auto_submit: true
      }
    }
  };
  return { ...value, ...overrides };
}

function page(marker, value, prefix = '# Human title\n') {
  return `${prefix}<!-- ${marker}:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- ${marker}:end -->\n`;
}

function manifest(configPage, overrides = {}) {
  const value = {
    schema_version: 1,
    project_id: 'ugnas/ugcli-lib',
    project_fingerprint: FINGERPRINT,
    documents: {
      'horspowers-config': {
        document_type: 'config',
        uri: CONFIG_URI,
        revision: 1,
        status: 'active',
        content_sha256: createHash('sha256').update(configPage, 'utf8').digest('hex'),
        updated_at: '2026-08-10T00:00:00Z'
      }
    }
  };
  return { ...value, ...overrides };
}

function fakeQmd(pages) {
  const calls = [];
  return {
    calls,
    client: {
      async getExact(uri) {
        calls.push(uri);
        if (!pages.has(uri)) return { ok: false, error_code: 'qmd_get_not_found' };
        return {
          ok: true,
          result: { content: [{ type: 'text', text: pages.get(uri) }] }
        };
      },
      async query() {
        throw new Error('configuration discovery must never call query');
      }
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('extracts one exact JSON machine block without normalizing page content', () => {
  const source = page('horspowers-registry', registry());
  const result = extractMachineJson(source, 'horspowers-registry', 256 * 1024);

  assert.equal(result.ok, true);
  assert.deepEqual(result.value, registry());
});

test('rejects missing, duplicate, malformed, and oversized machine blocks', () => {
  const valid = page('horspowers-registry', registry());
  const duplicateJsonKey = '<!-- horspowers-registry:start -->\n```json\n{"projects":{"same":{"value":1},"same":{"value":2}}}\n```\n<!-- horspowers-registry:end -->\n';
  const cases = [
    ['missing', '# no machine block\n', 256 * 1024],
    ['duplicate', `${valid}\n${valid}`, 256 * 1024],
    ['duplicate JSON key', duplicateJsonKey, 256 * 1024],
    ['malformed', '<!-- horspowers-registry:start -->\n```json\n{not json}\n```\n<!-- horspowers-registry:end -->\n', 256 * 1024],
    ['oversized', valid, 8]
  ];

  for (const [name, source, limit] of cases) {
    const result = extractMachineJson(source, 'horspowers-registry', limit);
    assert.equal(result.ok, false, name);
  }
});

test('validates the strict Registry schema and URI collection boundary', () => {
  const accepted = validateRegistry(registry(), hostConfig());
  assert.equal(accepted.ok, true);

  const opaqueProjectId = clone(registry());
  opaqueProjectId.projects[FINGERPRINT].project_id = 'ugnas/UGCLI Library';
  assert.equal(validateRegistry(opaqueProjectId, hostConfig()).ok, true);

  const unknown = clone(registry());
  unknown.unexpected = true;
  assert.equal(validateRegistry(unknown, hostConfig()).ok, false);

  const fingerprint = clone(registry());
  fingerprint.projects['sha256:UPPERCASE'] = fingerprint.projects[FINGERPRINT];
  delete fingerprint.projects[FINGERPRINT];
  assert.equal(validateRegistry(fingerprint, hostConfig()).ok, false);

  const escaped = clone(registry());
  escaped.projects[FINGERPRINT].config_uri = 'qmd://my-code-wiki/projects/%2e%2e/other/config.md';
  assert.equal(validateRegistry(escaped, hostConfig()).ok, false);
});

test('validates a strict Wiki project configuration against Registry and identity', () => {
  const expected = {
    project_id: 'ugnas/ugcli-lib',
    project_fingerprint: FINGERPRINT,
    config_uri: CONFIG_URI
  };
  assert.equal(validateWikiProjectConfig(projectConfig(), expected, hostConfig()).ok, true);

  const opaqueProjectId = 'ugnas/UGCLI Library';
  assert.equal(validateWikiProjectConfig(
    projectConfig({ project_id: opaqueProjectId }),
    { ...expected, project_id: opaqueProjectId },
    hostConfig()
  ).ok, true);

  const cases = [
    ['unknown top-level field', (value) => { value.unexpected = true; }],
    ['registry project mismatch', (value) => { value.project_id = 'ugnas/other'; }],
    ['identity fingerprint mismatch', (value) => { value.project_fingerprint = `sha256:${'b'.repeat(64)}`; }],
    ['non-wiki backend', (value) => { value.documentation.backend = 'local'; }],
    ['non inbox-only submission', (value) => { value.documentation.submission.mode = 'direct'; }],
    ['manifest outside root', (value) => { value.documentation.manifest_uri = 'qmd://my-code-wiki/projects/other/index.md'; }],
    ['encoded traversal root', (value) => { value.documentation.root_uri = 'qmd://my-code-wiki/projects/%2e%2e/other'; }]
  ];

  for (const [name, mutate] of cases) {
    const value = clone(projectConfig());
    mutate(value);
    assert.equal(validateWikiProjectConfig(value, expected, hostConfig()).ok, false, name);
  }
});

test('resolves Registry, config, and manifest through exactly three exact qmd reads', async () => {
  const configPage = page('horspowers-config', projectConfig(), '# config page\r\n');
  const manifestPage = page('horspowers-manifest', manifest(configPage));
  const { client, calls } = fakeQmd(new Map([
    [REGISTRY_URI, page('horspowers-registry', registry())],
    [CONFIG_URI, configPage],
    [MANIFEST_URI, manifestPage]
  ]));

  const result = await resolveWikiProjectConfig({
    identity: identity(),
    hostConfig: hostConfig(),
    qmdClient: client
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.config.project_id, 'ugnas/ugcli-lib');
  assert.equal(result.config_revision, 1);
  assert.deepEqual(calls, [REGISTRY_URI, CONFIG_URI, MANIFEST_URI]);
});

test('fails closed without local fallback for unavailable, unregistered, invalid, and incompatible external configuration', async () => {
  const unavailable = await resolveWikiProjectConfig({
    identity: identity(),
    hostConfig: hostConfig(),
    qmdClient: { async getExact() { return { ok: false, error_code: 'mcp_timeout' }; } }
  });
  assert.equal(unavailable.status, 'wiki_unavailable');

  const unregisteredQmd = fakeQmd(new Map([[REGISTRY_URI, page('horspowers-registry', {
    schema_version: 1,
    projects: {}
  })]]));
  const unregistered = await resolveWikiProjectConfig({
    identity: identity(), hostConfig: hostConfig(), qmdClient: unregisteredQmd.client
  });
  assert.equal(unregistered.status, 'unregistered_company_project');
  assert.equal(unregisteredQmd.calls.length, 1);

  const invalidQmd = fakeQmd(new Map([[REGISTRY_URI, '# broken registry\n']]));
  const invalid = await resolveWikiProjectConfig({
    identity: identity(), hostConfig: hostConfig(), qmdClient: invalidQmd.client
  });
  assert.equal(invalid.status, 'registry_invalid');

  const configPage = page('horspowers-config', projectConfig());
  const incompatibleManifest = manifest(configPage);
  incompatibleManifest.documents['horspowers-config'].content_sha256 = '0'.repeat(64);
  const incompatibleQmd = fakeQmd(new Map([
    [REGISTRY_URI, page('horspowers-registry', registry())],
    [CONFIG_URI, configPage],
    [MANIFEST_URI, page('horspowers-manifest', incompatibleManifest)]
  ]));
  const incompatible = await resolveWikiProjectConfig({
    identity: identity(), hostConfig: hostConfig(), qmdClient: incompatibleQmd.client
  });
  assert.equal(incompatible.status, 'project_config_incompatible');
  assert.deepEqual(incompatibleQmd.calls, [REGISTRY_URI, CONFIG_URI, MANIFEST_URI]);
});
