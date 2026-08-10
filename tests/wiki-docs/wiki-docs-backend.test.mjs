import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { WikiDocsBackend } from '../../lib/document-backends/wiki-docs-backend.mjs';
import { validateAndSerializeSafeDocument } from '../../lib/submission-safety.mjs';

const COLLECTION = 'my-code-wiki';
const ROOT_URI = `qmd://${COLLECTION}/projects/ugcli-lib`;
const MANIFEST_URI = `${ROOT_URI}/index.md`;
const CONFIG_URI = `${ROOT_URI}/horspowers-config.md`;
const TASK_URI = `${ROOT_URI}/tasks/implement-feature.md`;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const LOW_ENTROPY_IDENTIFIER_PADDING = 'a'.repeat(40);
const OPAQUE_IDENTIFIER_SEGMENTS = ['abcdefghij', 'klmnopqrst', 'uvwxyz012345'];

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function machinePage(marker, value, prefix = '# Wiki page\n\n') {
  return `${prefix}<!-- ${marker}:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- ${marker}:end -->\n`;
}

function projectConfig({ autoSubmit = true } = {}) {
  return {
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
      submission: { mode: 'inbox-only', auto_submit: autoSubmit }
    }
  };
}

function pagesFor(config = projectConfig(), { taskStatus = 'active', taskBody } = {}) {
  const configPage = machinePage('horspowers-config', config, '# Config\n\n');
  const taskPage = taskBody ?? '# Task\n\nImplement the bounded runtime.\n';
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
      },
      'implement-feature': {
        document_type: 'task',
        uri: TASK_URI,
        revision: 2,
        status: taskStatus,
        content_sha256: sha256(taskPage),
        updated_at: '2026-08-10T00:00:00Z'
      }
    }
  };
  return new Map([
    [CONFIG_URI, configPage],
    [MANIFEST_URI, machinePage('horspowers-manifest', manifest, '# Manifest\n\n')],
    [TASK_URI, taskPage]
  ]);
}

function pagesWithReferencedTask(config, logicalId, taskBody) {
  const pages = pagesFor(config);
  const manifestMatch = /<!-- horspowers-manifest:start -->\n```json\n([\s\S]+?)\n```\n<!-- horspowers-manifest:end -->/u.exec(pages.get(MANIFEST_URI));
  assert.ok(manifestMatch, 'fixture manifest must have a machine block');
  const manifest = JSON.parse(manifestMatch[1]);
  const uri = `${ROOT_URI}/tasks/${logicalId}.md`;
  manifest.documents[logicalId] = {
    document_type: 'task',
    uri,
    revision: 1,
    status: 'active',
    content_sha256: sha256(taskBody),
    updated_at: '2026-08-10T00:00:00Z'
  };
  pages.set(MANIFEST_URI, machinePage('horspowers-manifest', manifest, '# Manifest\n\n'));
  pages.set(uri, taskBody);
  return pages;
}

function fakeQmd(pages, searchResults = []) {
  const exactCalls = [];
  const searchCalls = [];
  return {
    exactCalls,
    searchCalls,
    client: {
      async getExact(uri) {
        exactCalls.push(uri);
        if (!pages.has(uri)) return { ok: false, error_code: 'qmd_get_not_found' };
        return { ok: true, result: { content: [{ type: 'text', text: pages.get(uri) }] } };
      },
      async search(args) {
        searchCalls.push(args);
        return { ok: true, result: { structuredContent: { results: searchResults } } };
      }
    }
  };
}

function safeDocument() {
  return {
    schema_version: 1,
    format: 'safe-document',
    title: 'Runtime boundary update',
    sections: [{
      heading: 'Summary',
      paragraphs: ['Describe the required behavior without copying implementation source.'],
      bullets: [],
      files: [],
      implementation_specs: [],
      commands: []
    }],
    references: []
  };
}

async function canonicalSafeDocument(document = safeDocument()) {
  const serialized = await validateAndSerializeSafeDocument(document, '/retained-fixture/company-project', {
    sourceSimilarityGuard: async () => ({ ok: true })
  });
  assert.equal(serialized.ok, true);
  return serialized.markdown;
}

function submissionMetadata(payload) {
  const match = /<!-- horspowers-submission:start -->\n```json\n([\s\S]+?)\n```\n<!-- horspowers-submission:end -->/u.exec(payload);
  assert.ok(match, 'submission metadata must be present');
  return JSON.parse(match[1]);
}

function proposedDocument(payload) {
  const marker = '## Proposed document\n\n';
  const index = payload.indexOf(marker);
  assert.notEqual(index, -1, 'submission body must be present');
  return payload.slice(index + marker.length);
}

function backend({
  pages: providedPages,
  searchResults = [],
  autoSubmit = true,
  projectId = 'ugnas/ugcli-lib',
  config: providedConfig,
  submitter = { async submit() { return { ok: true, filename: 'fixture.md' }; } },
  serializeSafeDocument = async () => ({ ok: true, markdown: '# Safe document\n' }),
  dependencies: injectedDependencies = {},
  inspectSubmissionText,
  inspectSubmissionMetadataIdentifier
} = {}) {
  const config = providedConfig ?? projectConfig({ autoSubmit });
  const pages = providedPages ?? pagesFor(config);
  const qmd = fakeQmd(pages, searchResults);
  const options = {
    projectRoot: '/retained-fixture/company-project',
    projectId,
    config,
    configUri: CONFIG_URI,
    hostConfig: { wiki: { collection: COLLECTION } },
    qmdClient: qmd.client,
    submitter,
    ...(inspectSubmissionText ? { inspectSubmissionText } : {})
  };
  const dependencies = {
    serializeSafeDocument,
    createSubmissionId: () => '123e4567-e89b-42d3-a456-426614174000',
    ...injectedDependencies,
    ...(inspectSubmissionMetadataIdentifier ? { inspectSubmissionMetadataIdentifier } : {})
  };
  return {
    qmd,
    backend: new WikiDocsBackend(options, dependencies)
  };
}

test('gets a document only after an exact manifest read and verifies its content hash', async () => {
  const fixture = backend();

  const result = await fixture.backend.get({ logical_id: 'implement-feature' });

  assert.equal(result.status, 'ok');
  assert.equal(result.backend, 'wiki');
  assert.equal(result.project_id, 'ugnas/ugcli-lib');
  assert.equal(result.document.revision, 2);
  assert.match(result.document.content, /bounded runtime/u);
  assert.deepEqual(fixture.qmd.exactCalls, [MANIFEST_URI, CONFIG_URI, TASK_URI]);
});

test('fails closed for a missing document or manifest/body mismatch without local fallback', async () => {
  const missing = backend();
  const missingResult = await missing.backend.get({ logical_id: 'not-present' });
  assert.equal(missingResult.status, 'document_not_found');
  assert.equal(missingResult.backend, 'wiki');

  const corruptPages = pagesFor();
  corruptPages.set(TASK_URI, '# Task\n\nChanged body.\n');
  const corrupt = backend({ pages: corruptPages });
  const corruptResult = await corrupt.backend.get({ logical_id: 'implement-feature' });
  assert.equal(corruptResult.status, 'manifest_content_mismatch');
  assert.equal(corruptResult.backend, 'wiki');
});

test('blocks high-entropy project and logical IDs before any Inbox submission', async () => {
  const submissions = [];
  const submitter = {
    async submit(submission) {
      submissions.push(submission);
      return { ok: true, filename: 'fixture.md' };
    }
  };
  const token = 'aB3dE5fG7hJ9kLmNpQrStUvWxYz01234';
  const unsafeConfig = projectConfig();
  unsafeConfig.project_id = `fixture/${token}`;
  const unsafeProjectPages = pagesFor(unsafeConfig);
  const unsafeProject = backend({
    config: unsafeConfig,
    pages: unsafeProjectPages,
    projectId: unsafeConfig.project_id,
    submitter
  });
  const projectResult = await unsafeProject.backend.create({
    document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(projectResult.status, 'submission_safety_blocked');
  assert.equal(projectResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(projectResult.project_id, null);
  assert.equal(JSON.stringify(projectResult).includes(token), false);
  assert.equal(submissions.length, 0);

  const projectArchive = await unsafeProject.backend.archive({
    document_type: 'task', logical_id: 'implement-feature', base_revision: 2,
    content_kind: 'status-transition',
    content: {
      uri: TASK_URI,
      content_sha256: sha256(unsafeProjectPages.get(TASK_URI)),
      from_status: 'active',
      to_status: 'archived'
    }
  });
  assert.equal(projectArchive.status, 'submission_safety_blocked');
  assert.equal(projectArchive.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(submissions.length, 0);

  const unsafeLogical = backend({ submitter });
  const unsafeLogicalId = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const unsafeRequests = [
    ['create', {
      document_type: 'plan', logical_id: unsafeLogicalId, base_revision: 0,
      content_kind: 'document', content: safeDocument()
    }],
    ['update', {
      document_type: 'task', logical_id: unsafeLogicalId, base_revision: 2,
      content_kind: 'document', content: safeDocument()
    }],
    ['archive', {
      document_type: 'task', logical_id: unsafeLogicalId, base_revision: 2,
      content_kind: 'status-transition',
      content: {
        uri: TASK_URI,
        content_sha256: sha256(pagesFor().get(TASK_URI)),
        from_status: 'active',
        to_status: 'archived'
      }
    }]
  ];
  for (const [operation, request] of unsafeRequests) {
    const logicalResult = await unsafeLogical.backend[operation](request);
    assert.equal(logicalResult.status, 'submission_safety_blocked', operation);
    assert.equal(logicalResult.errors?.[0]?.code, 'high_entropy_credential', operation);
  }
  assert.equal(submissions.length, 0);
});

test('does not let a generic text inspector override metadata identifier safety', async () => {
  const submissions = [];
  const submitter = {
    async submit(submission) {
      submissions.push(submission);
      return { ok: true, filename: 'unexpected.md' };
    }
  };
  const genericPassThrough = () => ({ ok: true });
  const unsafeToken = 'aB3dE5fG7hJ9kLmNpQrStUvWxYz01234';
  const unsafeProjectId = `fixture/${unsafeToken}`;
  const unsafeConfig = projectConfig();
  unsafeConfig.project_id = unsafeProjectId;

  const unsafeProject = backend({
    config: unsafeConfig,
    pages: pagesFor(unsafeConfig),
    projectId: unsafeProjectId,
    submitter,
    dependencies: { inspectSubmissionText: genericPassThrough }
  });
  const projectResult = await unsafeProject.backend.create({
    document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(projectResult.status, 'submission_safety_blocked');
  assert.equal(projectResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(projectResult.project_id, null);
  assert.equal(JSON.stringify(projectResult).includes(unsafeToken), false);

  const unsafeLogicalId = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const unsafeLogical = backend({ submitter, dependencies: { inspectSubmissionText: genericPassThrough } });
  const logicalResult = await unsafeLogical.backend.create({
    document_type: 'plan', logical_id: unsafeLogicalId, base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(logicalResult.status, 'submission_safety_blocked');
  assert.equal(logicalResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(JSON.stringify(logicalResult).includes(unsafeLogicalId), false);
  assert.equal(submissions.length, 0);
});

test('blocks high-entropy metadata even when separators split the opaque value', async () => {
  const submissions = [];
  const submitter = {
    async submit(input) {
      submissions.push(input);
      return { ok: true, filename: 'unexpected.md' };
    }
  };
  for (const token of [
    'abcdefghij-klmnopqrst-uvwxyz012345',
    'abcdefghij/klmnopqrst/uvwxyz012345',
    'aB3dE5fG7hJ9kLm/NpQrStUvWxYz0123',
    'abcdefghij.klmnopqrst.uvwxyz012345'
  ]) {
    const unsafeConfig = projectConfig();
    unsafeConfig.project_id = `fixture/${token}`;
    const unsafeProject = backend({ config: unsafeConfig, projectId: unsafeConfig.project_id, submitter });
    const projectResult = await unsafeProject.backend.create({
      document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
      content_kind: 'document', content: safeDocument()
    });
    assert.equal(projectResult.status, 'submission_safety_blocked', token);
    assert.equal(projectResult.errors?.[0]?.code, 'high_entropy_credential', token);
  }

  const unsafeLogical = backend({ submitter });
  const logicalResult = await unsafeLogical.backend.create({
    document_type: 'plan', logical_id: 'abcdefghij-klmnopqrst-uvwxyz012345', base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(logicalResult.status, 'submission_safety_blocked');
  assert.equal(logicalResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(submissions.length, 0);
});

test('blocks low-entropy padded high-entropy project and logical IDs before submitting', async () => {
  const submissions = [];
  const submitter = {
    async submit(input) {
      submissions.push(input);
      return { ok: true, filename: 'unexpected.md' };
    }
  };

  for (const separator of ['-', '/', '.']) {
    const opaqueSegments = OPAQUE_IDENTIFIER_SEGMENTS.join(separator);
    const unsafeProjectId = `fixture/${LOW_ENTROPY_IDENTIFIER_PADDING}${separator}${opaqueSegments}`;
    const unsafeConfig = projectConfig();
    unsafeConfig.project_id = unsafeProjectId;
    const fixture = backend({ config: unsafeConfig, projectId: unsafeProjectId, submitter });

    const result = await fixture.backend.create({
      document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
      content_kind: 'document', content: safeDocument()
    });

    assert.equal(result.status, 'submission_safety_blocked', separator);
    assert.equal(result.errors?.[0]?.code, 'high_entropy_credential', separator);
    assert.equal(result.project_id, null, separator);
    assert.equal(JSON.stringify(result).includes(unsafeProjectId), false, separator);
  }

  const unsafeLogicalId = `${LOW_ENTROPY_IDENTIFIER_PADDING}-${OPAQUE_IDENTIFIER_SEGMENTS.join('-')}`;
  const logicalFixture = backend({ submitter });
  const logicalResult = await logicalFixture.backend.create({
    document_type: 'plan', logical_id: unsafeLogicalId, base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });

  assert.equal(logicalResult.status, 'submission_safety_blocked');
  assert.equal(logicalResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(JSON.stringify(logicalResult).includes(unsafeLogicalId), false);
  assert.equal(submissions.length, 0);
});

test('rejects a high-entropy session reference before submitting any batch item', async () => {
  const submissions = [];
  const logicalId = 'abcdefghij-klmnopqrst-uvwxyz012345';
  const taskBody = await canonicalSafeDocument();
  const fixture = backend({
    pages: pagesWithReferencedTask(projectConfig(), logicalId, taskBody),
    serializeSafeDocument: async (content) => validateAndSerializeSafeDocument(content, '/retained-fixture/company-project', {
      sourceSimilarityGuard: async () => ({ ok: true })
    }),
    submitter: {
      async submit(input) {
        submissions.push(input);
        return { ok: true, filename: 'unexpected.md' };
      }
    }
  });

  const result = await fixture.backend.recordSession({
    session: {
      session_id: 'opaque-session-id',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/wiki-runtime'
    },
    document_refs: [{ document_type: 'task', logical_id: logicalId }],
    auto_archive_completed: false
  });

  assert.equal(result.status, 'submission_safety_blocked');
  assert.equal(result.errors?.[0]?.path, '$.references[0].logical_id');
  assert.equal(result.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(submissions.length, 0);
});

test('requires the manifest config entry to match the exact config page before reading documents', async () => {
  const pages = pagesFor();
  pages.set(CONFIG_URI, '# Config was changed without a manifest revision\n');
  const fixture = backend({ pages });

  const result = await fixture.backend.get({ logical_id: 'implement-feature' });

  assert.equal(result.status, 'config_manifest_mismatch');
  assert.deepEqual(fixture.qmd.exactCalls, [MANIFEST_URI, CONFIG_URI]);
});

test('fails before qmd access when the runtime project identity and Wiki config disagree', async () => {
  const fixture = backend({ projectId: 'other/project' });

  const result = await fixture.backend.get({ logical_id: 'implement-feature' });

  assert.equal(result.status, 'wiki_unavailable');
  assert.equal(result.error_code, 'wiki_runtime_config_invalid');
  assert.deepEqual(fixture.qmd.exactCalls, []);
});

test('pins query search to the configured collection and accepts only manifest-scoped URIs', async () => {
  const fixture = backend({ searchResults: [{ uri: TASK_URI, text: 'bounded runtime' }] });
  const result = await fixture.backend.search({ query: 'runtime', intent: 'find active task' });

  assert.equal(result.status, 'ok');
  assert.deepEqual(fixture.qmd.searchCalls, [{ query: 'runtime', intent: 'find active task' }]);
  assert.deepEqual(result.documents.map(document => document.logical_id), ['implement-feature']);
  assert.equal(result.documents[0].text, 'bounded runtime');

  const outside = backend({ searchResults: [{ uri: `qmd://${COLLECTION}/projects/other/task.md`, text: 'wrong' }] });
  const outsideResult = await outside.backend.search({ query: 'runtime', intent: 'find active task' });
  assert.equal(outsideResult.status, 'wiki_search_invalid');

  const duplicate = backend({ searchResults: [
    { uri: TASK_URI, text: 'one' },
    { uri: TASK_URI, text: 'two' }
  ] });
  const duplicateResult = await duplicate.backend.search({ query: 'runtime', intent: 'find active task' });
  assert.equal(duplicateResult.status, 'wiki_search_invalid');
});

test('submits a safe document mutation only after matching its manifest revision and applies one auto-submit switch', async () => {
  const submissions = [];
  const submitter = {
    async submit(input) {
      submissions.push(input);
      return { ok: true, filename: 'fixture.md' };
    }
  };
  const fixture = backend({ submitter });
  const mutation = {
    document_type: 'task',
    logical_id: 'implement-feature',
    base_revision: 2,
    content_kind: 'document',
    content: safeDocument()
  };

  const result = await fixture.backend.update(mutation);

  assert.equal(result.status, 'submitted_pending_review');
  assert.equal(submissions.length, 1);
  assert.match(submissions[0].payload, /"base_revision": 2/u);
  assert.match(submissions[0].payload, /"proposed_revision": 3/u);

  const confirmation = backend({ autoSubmit: false, submitter });
  const waiting = await confirmation.backend.update(mutation);
  assert.equal(waiting.status, 'confirmation_required');
  assert.equal(submissions.length, 1);

  const confirmed = await confirmation.backend.update(mutation, { confirmed: true });
  assert.equal(confirmed.status, 'submitted_pending_review');
  assert.equal(submissions.length, 2);
});

test('uses a metadata-only status transition after verifying manifest and body identity', async () => {
  const submissions = [];
  const fixture = backend({
    submitter: {
      async submit(input) {
        submissions.push(input);
        return { ok: true, filename: 'fixture.md' };
      }
    }
  });
  const taskPage = pagesFor().get(TASK_URI);
  const result = await fixture.backend.archive({
    document_type: 'task',
    logical_id: 'implement-feature',
    base_revision: 2,
    content_kind: 'status-transition',
    content: {
      uri: TASK_URI,
      content_sha256: sha256(taskPage),
      from_status: 'active',
      to_status: 'archived'
    }
  });

  assert.equal(result.status, 'submitted_pending_review');
  assert.deepEqual(fixture.qmd.exactCalls, [MANIFEST_URI, CONFIG_URI, TASK_URI]);
  assert.equal(submissions.length, 1);
  assert.match(submissions[0].payload, /horspowers-status-transition:start/u);
  assert.equal(submissions[0].payload.includes(taskPage), false);
});

test('rechecks the config manifest entry before a config-change and renders only its machine block', async () => {
  const submissions = [];
  const fixture = backend({
    submitter: {
      async submit(input) {
        submissions.push(input);
        return { ok: true, filename: 'config.md' };
      }
    }
  });
  const proposed = projectConfig({ autoSubmit: false });
  const result = await fixture.backend.configChange({
    document_type: 'config',
    logical_id: 'horspowers-config',
    base_revision: 3,
    content_kind: 'project-config',
    content: proposed
  });

  assert.equal(result.status, 'submitted_pending_review');
  assert.deepEqual(fixture.qmd.exactCalls, [MANIFEST_URI, CONFIG_URI]);
  assert.equal(submissions.length, 1);
  assert.match(submissions[0].payload, /horspowers-config:start/u);
  assert.match(submissions[0].payload, /"base_revision": 3/u);
  assert.match(submissions[0].payload, /"proposed_revision": 4/u);

  const stale = await fixture.backend.configChange({
    document_type: 'config',
    logical_id: 'horspowers-config',
    base_revision: 2,
    content_kind: 'project-config',
    content: proposed
  });
  assert.equal(stale.status, 'document_conflict');
  assert.equal(submissions.length, 1);
});

test('rejects a config-change that widens or redirects the verified Wiki document scope', async () => {
  let submitCalls = 0;
  const fixture = backend({
    submitter: {
      async submit() {
        submitCalls += 1;
        return { ok: true, filename: 'unexpected.md' };
      }
    }
  });
  const proposed = projectConfig();
  proposed.documentation.root_uri = `qmd://${COLLECTION}/projects`;
  proposed.documentation.manifest_uri = `qmd://${COLLECTION}/projects/other-project/index.md`;

  const result = await fixture.backend.configChange({
    document_type: 'config',
    logical_id: 'horspowers-config',
    base_revision: 3,
    content_kind: 'project-config',
    content: proposed
  });

  assert.equal(result.status, 'project_config_incompatible');
  assert.equal(result.error_code, 'config_documentation_scope_mismatch');
  assert.equal(submitCalls, 0);
});

test('uses one confirmation for a session batch and reports partial Inbox transport failures', async () => {
  const submissions = [];
  const submitter = {
    async submit(input) {
      submissions.push(input);
      return submissions.length === 2
        ? { ok: false, error_code: 'inbox_process_exit' }
        : { ok: true, filename: `${submissions.length}.md` };
    }
  };
  const fixture = backend({ autoSubmit: false, submitter });
  const request = {
    session: {
      session_id: 'opaque-session-id',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/wiki-runtime'
    },
    document_refs: [],
    auto_archive_completed: false
  };

  const pending = await fixture.backend.recordSession(request);
  assert.equal(pending.status, 'confirmation_required');
  assert.equal(submissions.length, 0);
  assert.equal(pending.previews.length, 1);

  const first = await fixture.backend.recordSession(request, { confirmed: true });
  assert.equal(first.status, 'submitted_pending_review');
  assert.equal(first.submissions.length, 1);

  const second = await fixture.backend.mutateBatch([
    {
      operation: 'update',
      mutation: {
        document_type: 'task',
        logical_id: 'implement-feature',
        base_revision: 2,
        content_kind: 'document',
        content: safeDocument()
      }
    },
    {
      operation: 'archive',
      mutation: {
        document_type: 'task',
        logical_id: 'implement-feature',
        base_revision: 2,
        content_kind: 'status-transition',
        content: {
          uri: TASK_URI,
          content_sha256: sha256(pagesFor().get(TASK_URI)),
          from_status: 'active',
          to_status: 'archived'
        }
      }
    }
  ], { confirmed: true });
  assert.equal(second.status, 'partially_submitted');
  assert.equal(second.submissions.length, 1);
  assert.equal(second.failures.length, 1);
  assert.equal(second.failures[0].error_code, 'inbox_process_exit');
  assert.match(second.failures[0].submission_id, /^[0-9a-f-]{36}$/u);
});

test('records each referenced document state once and rejects duplicate session references', async () => {
  const config = projectConfig();
  const serialized = [];
  const submissions = [];
  const taskBody = await canonicalSafeDocument();
  const fixture = backend({
    config,
    pages: pagesFor(config, { taskStatus: 'completed', taskBody }),
    serializeSafeDocument: async (content) => {
      serialized.push(content);
      return { ok: true, markdown: '# Session document\n' };
    },
    submitter: {
      async submit(input) {
        submissions.push(input);
        return { ok: true, filename: 'session.md' };
      }
    }
  });
  const session = {
    session_id: 'opaque-session-id',
    ended_at: '2026-08-10T00:00:00Z',
    branch: 'feat/wiki-runtime'
  };
  const reference = { document_type: 'task', logical_id: 'implement-feature' };

  const recorded = await fixture.backend.recordSession({
    session,
    document_refs: [reference],
    auto_archive_completed: true
  });

  assert.equal(recorded.status, 'submitted_pending_review');
  assert.equal(recorded.submissions.length, 3);
  assert.deepEqual(serialized[0].sections[0].bullets, [
    'Ended at: 2026-08-10T00:00:00Z',
    'Branch: feat/wiki-runtime',
  ]);
  assert.deepEqual(serialized[0].sections[1].bullets, [
    'A referenced task is completed at revision 2.'
  ]);

  const duplicateFixture = backend({
    config,
    pages: pagesFor(config, { taskStatus: 'completed' }),
    submitter: {
      async submit() {
        throw new Error('duplicate references must not submit');
      }
    }
  });
  const duplicate = await duplicateFixture.backend.recordSession({
    session,
    document_refs: [reference, reference],
    auto_archive_completed: true
  });

  assert.equal(duplicate.status, 'invalid_request');
  assert.equal(duplicate.error_code, 'session_reference_duplicate');
});

test('records reference progress before dependent archive using virtual revision and content-hash state', async () => {
  const taskBody = await canonicalSafeDocument();
  const submissions = [];
  const fixture = backend({
    pages: pagesFor(projectConfig(), { taskStatus: 'completed', taskBody }),
    serializeSafeDocument: async (content) => validateAndSerializeSafeDocument(content, '/retained-fixture/company-project', {
      sourceSimilarityGuard: async () => ({ ok: true })
    }),
    submitter: {
      async submit(input) {
        submissions.push(input);
        return { ok: true, filename: `${submissions.length}.md` };
      }
    }
  });

  const result = await fixture.backend.recordSession({
    session: {
      session_id: 'opaque-session-id',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/wiki-runtime'
    },
    document_refs: [{ document_type: 'task', logical_id: 'implement-feature' }],
    auto_archive_completed: true
  });

  assert.equal(result.status, 'submitted_pending_review');
  assert.equal(submissions.length, 3);
  const metadata = submissions.map(({ payload }) => submissionMetadata(payload));
  assert.deepEqual(metadata.map(entry => entry.operation), ['create', 'update', 'archive']);
  assert.deepEqual(metadata.map(entry => entry.logical_id), [
    's-26o25gooys4pxtqa4',
    'implement-feature',
    'implement-feature'
  ]);
  assert.equal(metadata[1].base_revision, 2);
  assert.equal(metadata[1].proposed_revision, 3);
  assert.equal(metadata[2].base_revision, 3);
  assert.equal(metadata[2].proposed_revision, 4);

  const updatedBody = proposedDocument(submissions[1].payload);
  const transitionMatch = /<!-- horspowers-status-transition:start -->\n```json\n([\s\S]+?)\n```\n<!-- horspowers-status-transition:end -->/u.exec(proposedDocument(submissions[2].payload));
  assert.ok(transitionMatch, 'archive must carry a status-transition machine block');
  const transition = JSON.parse(transitionMatch[1]);
  assert.equal(transition.content_sha256, sha256(updatedBody));
  assert.equal(transition.from_status, 'completed');
  assert.equal(transition.to_status, 'archived');
});

test('does not submit a dependent archive when the reference progress submission fails', async () => {
  const taskBody = await canonicalSafeDocument();
  const submissions = [];
  const fixture = backend({
    pages: pagesFor(projectConfig(), { taskStatus: 'completed', taskBody }),
    serializeSafeDocument: async (content) => validateAndSerializeSafeDocument(content, '/retained-fixture/company-project', {
      sourceSimilarityGuard: async () => ({ ok: true })
    }),
    submitter: {
      async submit(input) {
        submissions.push(input);
        return submissions.length === 2
          ? { ok: false, error_code: 'inbox_process_exit' }
          : { ok: true, filename: `${submissions.length}.md` };
      }
    }
  });

  const result = await fixture.backend.recordSession({
    session: {
      session_id: 'opaque-session-id',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/wiki-runtime'
    },
    document_refs: [{ document_type: 'task', logical_id: 'implement-feature' }],
    auto_archive_completed: true
  });

  assert.equal(result.status, 'partially_submitted');
  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.map(({ payload }) => submissionMetadata(payload).operation), ['create', 'update']);
  assert.ok(result.failures.some(failure => failure.operation === 'archive' && failure.error_code === 'submission_dependency_failed'));
});

test('fails closed rather than rewriting an arbitrary referenced Markdown page during session recording', async () => {
  const submissions = [];
  const fixture = backend({
    pages: pagesFor(projectConfig(), { taskStatus: 'active', taskBody: '# Task\n\nUnstructured existing Markdown.\n' }),
    submitter: {
      async submit(input) {
        submissions.push(input);
        return { ok: true, filename: 'unexpected.md' };
      }
    }
  });

  const result = await fixture.backend.recordSession({
    session: {
      session_id: 'opaque-session-id',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/wiki-runtime'
    },
    document_refs: [{ document_type: 'task', logical_id: 'implement-feature' }],
    auto_archive_completed: false
  });

  assert.equal(result.status, 'safe_document_required');
  assert.equal(submissions.length, 0);
});

test('requires explicit mutation bases and a complete, valid session request', async () => {
  const fixture = backend();
  const missingBase = await fixture.backend.update({
    document_type: 'task',
    logical_id: 'implement-feature',
    content_kind: 'document',
    content: safeDocument()
  });
  assert.equal(missingBase.status, 'invalid_request');
  assert.equal(missingBase.error_code, 'mutation_request_invalid');

  const invalidTimestamp = await fixture.backend.recordSession({
    session: {
      session_id: 'opaque-session-id',
      ended_at: '2026-02-30T00:00:00Z',
      branch: 'feat/wiki-runtime'
    },
    document_refs: [],
    auto_archive_completed: false
  });
  assert.equal(invalidTimestamp.status, 'invalid_request');
  assert.equal(invalidTimestamp.error_code, 'session_invalid');

  const incomplete = await fixture.backend.recordSession({
    session: {
      session_id: 'opaque-session-id',
      ended_at: '2026-08-10T00:00:00Z',
      branch: 'feat/wiki-runtime'
    }
  });
  assert.equal(incomplete.status, 'invalid_request');
  assert.equal(incomplete.error_code, 'session_request_invalid');
});

test('rejects config status transitions before rendering an Inbox envelope', async () => {
  let submitCalls = 0;
  const fixture = backend({
    submitter: {
      async submit() {
        submitCalls += 1;
        return { ok: true };
      }
    }
  });
  const configPage = pagesFor().get(CONFIG_URI);
  const result = await fixture.backend.archive({
    document_type: 'config',
    logical_id: 'horspowers-config',
    base_revision: 3,
    content_kind: 'status-transition',
    content: {
      uri: CONFIG_URI,
      content_sha256: sha256(configPage),
      from_status: 'active',
      to_status: 'archived'
    }
  });

  assert.equal(result.status, 'invalid_request');
  assert.equal(result.error_code, 'status_transition_document_type_invalid');
  assert.equal(submitCalls, 0);
});

test('never returns untrusted safety or transport error detail', async () => {
  const marker = 'SENSITIVE_BACKEND_DETAIL_9d4c4a';
  const mutation = {
    document_type: 'task',
    logical_id: 'implement-feature',
    base_revision: 2,
    content_kind: 'document',
    content: safeDocument()
  };
  const safetyFixture = backend({
    serializeSafeDocument: async () => ({
      ok: false,
      error_code: 'raw_source_detected',
      errors: [{ path: '$.sections[0]', code: marker, value: marker }]
    })
  });
  const safetyResult = await safetyFixture.backend.update(mutation);
  assert.equal(safetyResult.status, 'raw_source_detected');
  assert.equal(JSON.stringify(safetyResult).includes(marker), false);

  const transportFixture = backend({
    submitter: { async submit() { return { ok: false, error_code: marker }; } }
  });
  const transportResult = await transportFixture.backend.update(mutation);
  assert.equal(transportResult.status, 'submission_failed');
  assert.equal(JSON.stringify(transportResult).includes(marker), false);
});

test('uses the single auto-submit switch for every mutation variant', async () => {
  const config = projectConfig({ autoSubmit: false });
  const activeTaskPage = pagesFor(config).get(TASK_URI);
  const archivedPages = pagesFor(config, { taskStatus: 'archived' });
  const archivedTaskPage = archivedPages.get(TASK_URI);
  const cases = [
    {
      action: 'create',
      request: {
        document_type: 'plan', logical_id: 'new-plan', base_revision: 0,
        content_kind: 'document', content: safeDocument()
      }
    },
    {
      action: 'update',
      request: {
        document_type: 'task', logical_id: 'implement-feature', base_revision: 2,
        content_kind: 'document', content: safeDocument()
      }
    },
    {
      action: 'archive',
      request: {
        document_type: 'task', logical_id: 'implement-feature', base_revision: 2,
        content_kind: 'status-transition',
        content: {
          uri: TASK_URI, content_sha256: sha256(activeTaskPage), from_status: 'active', to_status: 'archived'
        }
      }
    },
    {
      action: 'restore',
      pages: archivedPages,
      request: {
        document_type: 'task', logical_id: 'implement-feature', base_revision: 2,
        content_kind: 'status-transition',
        content: {
          uri: TASK_URI, content_sha256: sha256(archivedTaskPage), from_status: 'archived', to_status: 'active'
        }
      }
    },
    {
      action: 'config-change',
      request: {
        document_type: 'config', logical_id: 'horspowers-config', base_revision: 3,
        content_kind: 'project-config', content: config
      }
    }
  ];

  for (const item of cases) {
    let submitCalls = 0;
    const fixture = backend({
      autoSubmit: false,
      config,
      ...(item.pages ? { pages: item.pages } : {}),
      submitter: { async submit() { submitCalls += 1; return { ok: true }; } }
    });
    const result = await fixture.backend.execute(item.action, item.request);
    assert.equal(result.status, 'confirmation_required', item.action);
    assert.equal(submitCalls, 0, item.action);
  }
});
