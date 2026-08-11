import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { WikiDocsBackend } from '../../lib/document-backends/wiki-docs-backend.mjs';
import { validateAndSerializeSafeDocument } from '../../lib/submission-safety.mjs';

const COLLECTION = 'my-code-wiki';
const ROOT_URI = `qmd://${COLLECTION}/projects/ugcli-lib`;
const MANIFEST_URI = `${ROOT_URI}/index.md`;
const CONFIG_URI = `${ROOT_URI}/horspowers-config.md`;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function machinePage(marker, value, prefix = '# Wiki page\n\n') {
  return `${prefix}<!-- ${marker}:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- ${marker}:end -->\n`;
}

function projectConfig({ enabled = true, autoSubmit = true } = {}) {
  return {
    schema_version: 1,
    project_id: 'ugnas/ugcli-lib',
    project_fingerprint: FINGERPRINT,
    development_mode: 'team',
    branch_strategy: 'worktree',
    testing_strategy: 'tdd',
    completion_strategy: 'pr',
    documentation: {
      enabled,
      backend: 'wiki',
      collection: COLLECTION,
      root_uri: ROOT_URI,
      manifest_uri: MANIFEST_URI,
      submission: { mode: 'inbox-only', auto_submit: autoSubmit }
    }
  };
}

function pagesFor(config) {
  const configPage = machinePage('horspowers-config', config, '# Config\n\n');
  const manifest = {
    schema_version: 1,
    project_id: config.project_id,
    project_fingerprint: config.project_fingerprint,
    documents: {
      'horspowers-config': {
        document_type: 'config',
        uri: CONFIG_URI,
        revision: 3,
        status: 'active',
        content_sha256: sha256(configPage),
        updated_at: '2026-08-10T00:00:00Z'
      }
    }
  };
  return new Map([
    [CONFIG_URI, configPage],
    [MANIFEST_URI, machinePage('horspowers-manifest', manifest, '# Manifest\n\n')]
  ]);
}

function safeDocument() {
  return {
    schema_version: 1,
    format: 'safe-document',
    title: 'Bounded validation result',
    sections: [{
      heading: 'Summary',
      paragraphs: ['Describe the expected behavior.'],
      bullets: [],
      files: [],
      implementation_specs: [],
      commands: []
    }],
    references: []
  };
}

function backend({ config, submitter }) {
  const pages = pagesFor(config);
  const qmdClient = {
    async getExact(uri) {
      if (!pages.has(uri)) return { ok: false, error_code: 'qmd_get_not_found' };
      return { ok: true, result: { content: [{ type: 'text', text: pages.get(uri) }] } };
    },
    async search() {
      return { ok: true, result: { structuredContent: { results: [] } } };
    }
  };
  return new WikiDocsBackend({
    projectRoot: '/retained-fixture/company-project',
    projectId: config.project_id,
    config,
    configUri: CONFIG_URI,
    hostConfig: { wiki: { collection: COLLECTION } },
    qmdClient,
    submitter
  }, {
    createSubmissionId: () => '123e4567-e89b-42d3-a456-426614174000',
    serializeSafeDocument: (content, projectRoot) => validateAndSerializeSafeDocument(content, projectRoot, {
      sourceSimilarityGuard: async () => ({ ok: true })
    })
  });
}

function configChange(content) {
  return {
    document_type: 'config',
    logical_id: 'horspowers-config',
    base_revision: 3,
    content_kind: 'project-config',
    content
  };
}

test('config-change permits a strict Wiki config to disable documentation and revise a disabled config', async () => {
  const submissions = [];
  const submitter = {
    async submit(input) {
      submissions.push(input);
      return { ok: true, filename: 'fixture.md' };
    }
  };

  const enabledConfig = projectConfig({ enabled: true });
  const disableProposal = structuredClone(enabledConfig);
  disableProposal.documentation.enabled = false;
  const disableResult = await backend({ config: enabledConfig, submitter }).configChange(configChange(disableProposal));

  assert.equal(disableResult.status, 'submitted_pending_review');
  assert.equal(submissions.length, 1);
  assert.match(submissions[0].payload, /"enabled": false/u);

  const disabledConfig = projectConfig({ enabled: false });
  const disabledRevision = structuredClone(disabledConfig);
  disabledRevision.completion_strategy = 'keep';
  const revisionResult = await backend({ config: disabledConfig, submitter }).configChange(configChange(disabledRevision));

  assert.equal(revisionResult.status, 'submitted_pending_review');
  assert.equal(submissions.length, 2);
});

test('safe-document and Wiki backend redact unknown user field names from validation errors', async () => {
  const sensitiveField = 'private_token_not_for_error_output_8d1d3f';
  const document = safeDocument();
  document.sections[0][sensitiveField] = 'also-not-for-output';

  const directResult = await validateAndSerializeSafeDocument(document, '/retained-fixture/company-project', {
    sourceSimilarityGuard: async () => ({ ok: true })
  });

  assert.equal(directResult.ok, false);
  assert.deepEqual(directResult.errors, [{ path: '$.sections[0].unknown_field', code: 'unknown_field' }]);
  assert.equal(JSON.stringify(directResult).includes(sensitiveField), false);

  const result = await backend({ config: projectConfig(), submitter: { async submit() { throw new Error('must not submit'); } } }).create({
    document_type: 'task',
    logical_id: 'new-task',
    base_revision: 0,
    content_kind: 'document',
    content: document
  });

  assert.equal(result.status, 'safe_document_required');
  assert.deepEqual(result.errors, [{ path: '$.unknown_field', code: 'unknown_field' }]);
  assert.equal(JSON.stringify(result).includes(sensitiveField), false);
});

test('Wiki backend replaces an untrusted validation path with a fixed safe path', async () => {
  const sensitiveField = 'private_token_not_for_error_output_8d1d3f';
  const fixture = new WikiDocsBackend({
    projectRoot: '/retained-fixture/company-project',
    projectId: 'ugnas/ugcli-lib',
    config: projectConfig(),
    configUri: CONFIG_URI,
    hostConfig: { wiki: { collection: COLLECTION } },
    qmdClient: {
      async getExact(uri) {
        const pages = pagesFor(projectConfig());
        if (!pages.has(uri)) return { ok: false, error_code: 'qmd_get_not_found' };
        return { ok: true, result: { content: [{ type: 'text', text: pages.get(uri) }] } };
      }
    },
    submitter: { async submit() { throw new Error('must not submit'); } }
  }, {
    serializeSafeDocument: async () => ({
      ok: false,
      error_code: 'safe_document_required',
      errors: [{ path: `$.sections[0].${sensitiveField}`, code: 'unknown_field' }]
    })
  });

  const result = await fixture.create({
    document_type: 'task',
    logical_id: 'new-task',
    base_revision: 0,
    content_kind: 'document',
    content: safeDocument()
  });

  assert.equal(result.status, 'safe_document_required');
  assert.deepEqual(result.errors, [{ path: '$.unknown_field', code: 'unknown_field' }]);
  assert.equal(JSON.stringify(result).includes(sensitiveField), false);
});
