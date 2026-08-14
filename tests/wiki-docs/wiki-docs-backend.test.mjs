import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { WikiDocsBackend } from '../../lib/document-backends/wiki-docs-backend.mjs';
import { validateAndSerializeSafeDocument } from '../../lib/submission-safety.mjs';

function qmdResourceText(text) {
  return `<!-- Context: test -->\n\n${text.split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n')}`;
}

const COLLECTION = 'my-code-wiki';
const ROOT_URI = `qmd://${COLLECTION}/projects/ugcli-lib`;
const MANIFEST_URI = `${ROOT_URI}/index.md`;
const CONFIG_URI = `${ROOT_URI}/horspowers-config.md`;
const TASK_URI = `${ROOT_URI}/tasks/implement-feature.md`;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const LOW_ENTROPY_IDENTIFIER_PADDING = 'a'.repeat(40);
const OPAQUE_IDENTIFIER_SEGMENTS = ['abcdefghij', 'klmnopqrst', 'uvwxyz012345'];
const INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('a'.repeat(12));
const SHORT_INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('a'.repeat(7));
const REPEATED_NON_PERIODIC_INTERLEAVED_OPAQUE_IDENTIFIER =
  ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('000000010');
const SHORTER_INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7', 'g9h2j4', 'm6n8p0', 'r2s4t6'].join('a'.repeat(5));
const VARIED_TERNARY_INTERLEAVED_OPAQUE_IDENTIFIER = [
  'a3d5e7f', 'aaabacaaabcb', 'g9h2j4k', 'aacaabaaacbc', 'm6n8p0q', 'abaacaaaabcb', 'r2s4t6u'
].join('');
const LOW_ENTROPY_SHORT_CHUNK_INTERLEAVED_IDENTIFIER = ['abcde', 'fghij', 'klmno', 'pqrst', 'uvwxy'].join('a'.repeat(7));
const REPEATED_OPAQUE_IDENTIFIER = ['a3d5e7fg9h2j', 'a'.repeat(10), 'a3d5e7fg9h2j', 'a'.repeat(10), 'a3d5e7fg9h2j'].join('');
const PAIRED_OPAQUE_IDENTIFIER = 'aabbccddeeffgghhiijjkkllmmnnooppqqrrsstt';
const LOWERCASE_OPAQUE_IDENTIFIER = 'qwertyuiopasdfghjklz';
const SINGLE_CHARACTER_INTERLEAVED_LOWERCASE_OPAQUE_IDENTIFIER = LOWERCASE_OPAQUE_IDENTIFIER
  .split('').map(character => `${character}a`).join('');
const SHORT_SEGMENTED_OPAQUE_IDENTIFIER = ['abcd', 'efgh', 'ijkl', 'mnop', 'qrst', 'uvwx', 'yz01'].join('-');
const PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER = ['potib', 'kruhe', 'xafiz', 'uneba', 'jerex', 'itypu', 'povwf'].join('-');
const VARIABLE_PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER =
  'potib-kruhex-afizun-eba-jerexx-itypu-povwfa';
const NEARLY_REPEATED_LOW_ENTROPY_INTERLEAVED_IDENTIFIER = 'qweraabbcty1uaabbcioplaabbcsdfgaabbchjkl';
const TWO_PADDING_ONE_OPAQUE_INTERLEAVED_IDENTIFIER = ['qwertyu', 'a'.repeat(5), 'iop1asd', 'a'.repeat(5), 'fghjklz'].join('');
const HYPHEN_SPLIT_LOWERCASE_OPAQUE_IDENTIFIER = 'kzqvmp-jdthra-xlyfecwb';
const THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER = ['c3d5', 'e7f9', 'g2h4', 'j6k8', 'l0m1', 'n3p5', 'q7r9', 's2t4'].join('aaa');
const DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER = [
  'a3', 'd5', 'e7', 'fg', '9h', '2j', '4k', 'm6', 'n8', 'p0', 'qr', '2s', '4t', '6u'
].join('aba');
const DENSE_FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER = 'a3d5e7fg9h2j4km6n8p0qr2s4t6u'.split('').join('abca');
const DISTINCT_DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER = (() => {
  const core = 'a3d5e7fg9h2j4km6n8p0';
  const padding = [];
  for (const first of ['a', 'b', 'c']) {
    for (const second of ['a', 'b', 'c']) {
      for (const third of ['a', 'b', 'c']) padding.push(`${first}${second}${third}`);
    }
  }
  return core.split('').map((character, index) => `${character}${padding[index] ?? ''}`).join('');
})();
const FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER = 'c3d5aaabe7f9aaabg2h4aaabj6k8aaabl0m1aaabn3p5aaabq7r9aaabs2t4';
const TWO_SINGLETON_PADDING_OPAQUE_IDENTIFIER = 'qweraaabcty1uaaabcioplaaabcsdfgaaabchjkl';
const DISTINCT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER = 'a3d5e7fcacccabbcabcg9h2j4kbaaabccacbcam6n8p0qaccbccbbbacbr2s4t6u';
const DISTINCT_SHORT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER = '3at83u9aabbacb83u50nicacaacaba54zilcnabbbcccaayx8bupk';
const DISTINCT_ADJACENT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER = 'cra98z2cbba5cr29cfcbacaaccaababi9k7udscccacbbbacaccvat0r6x';
const OPAQUE_IDENTIFIER_CORE = 'a3d5e7fg9h2j4km6n8p0';
const LONG_PERIODIC_PADDING_OPAQUE_IDENTIFIER = OPAQUE_IDENTIFIER_CORE.match(/.{1,3}/gu).join('aabbaabbaa');
const EIGHT_CHARACTER_PADDING_OPAQUE_IDENTIFIER = OPAQUE_IDENTIFIER_CORE.match(/.{1,3}/gu).join('abcdabcd');
const LONG_PERIODIC_PADDING_PROJECT_IDENTIFIER = `group/${OPAQUE_IDENTIFIER_CORE.match(/.{1,2}/gu).join('000000010')}`;
const DECIMAL_CHARACTER_CODE_OPAQUE_IDENTIFIER = OPAQUE_IDENTIFIER_CORE
  .split('').map(character => `x${character.charCodeAt(0).toString().padStart(3, '0')}`).join('');
const FULLWIDTH_OPAQUE_PROJECT_IDENTIFIER = `fixture/${OPAQUE_IDENTIFIER_CORE.replace(/[a-z0-9]/gu, (character) =>
  String.fromCodePoint(character >= '0' && character <= '9'
    ? 0xff10 + Number(character)
    : 0xff41 + character.charCodeAt(0) - 'a'.charCodeAt(0)))}`;
const SEMANTIC_LOOKING_OPAQUE_IDENTIFIER = 'ther-inat-onre-comel-iquve';
const NESTED_READABLE_PROJECT_ID = 'ugnas-gitlab/ugos-pro/service/ug-system-cli';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function machinePage(marker, value, prefix = '# Wiki page\n\n') {
  return `${prefix}<!-- ${marker}:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- ${marker}:end -->\n`;
}

function projectConfig({ autoSubmit = true, enabled = true } = {}) {
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

function fakeQmd(pages, searchResults = [], { contentType = 'text' } = {}) {
  const exactCalls = [];
  const searchCalls = [];
  return {
    exactCalls,
    searchCalls,
    client: {
      async getExact(uri) {
        exactCalls.push(uri);
        if (!pages.has(uri)) return { ok: false, error_code: 'qmd_get_not_found' };
        const text = pages.get(uri);
        const content = contentType === 'resource'
          ? [{ type: 'resource', resource: { uri, mimeType: 'text/markdown', text: qmdResourceText(text) } }]
          : [{ type: 'text', text }];
        return { ok: true, result: { content } };
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
  inspectSubmissionMetadataIdentifier,
  qmdContentType = 'text'
} = {}) {
  const config = providedConfig ?? projectConfig({ autoSubmit });
  const pages = providedPages ?? pagesFor(config);
  const qmd = fakeQmd(pages, searchResults, { contentType: qmdContentType });
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

test('gets a document when qmd returns resource content blocks', async () => {
  const fixture = backend({ qmdContentType: 'resource' });

  const result = await fixture.backend.get({ logical_id: 'implement-feature' });

  assert.equal(result.status, 'ok');
  assert.match(result.document.content, /bounded runtime/u);
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

  const interleavedProjectId = `fixture/${INTERLEAVED_OPAQUE_IDENTIFIER}`;
  const interleavedConfig = projectConfig();
  interleavedConfig.project_id = interleavedProjectId;
  const interleavedProject = backend({ config: interleavedConfig, projectId: interleavedProjectId, submitter });
  const interleavedProjectResult = await interleavedProject.backend.create({
    document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(interleavedProjectResult.status, 'submission_safety_blocked');
  assert.equal(interleavedProjectResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(interleavedProjectResult.project_id, null);
  assert.equal(JSON.stringify(interleavedProjectResult).includes(interleavedProjectId), false);

  const interleavedLogicalFixture = backend({ submitter });
  const interleavedLogicalResult = await interleavedLogicalFixture.backend.create({
    document_type: 'plan', logical_id: INTERLEAVED_OPAQUE_IDENTIFIER, base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(interleavedLogicalResult.status, 'submission_safety_blocked');
  assert.equal(interleavedLogicalResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(JSON.stringify(interleavedLogicalResult).includes(INTERLEAVED_OPAQUE_IDENTIFIER), false);

  for (const identifier of [
    SHORT_INTERLEAVED_OPAQUE_IDENTIFIER,
    REPEATED_NON_PERIODIC_INTERLEAVED_OPAQUE_IDENTIFIER,
    SHORTER_INTERLEAVED_OPAQUE_IDENTIFIER,
    VARIED_TERNARY_INTERLEAVED_OPAQUE_IDENTIFIER,
    LOW_ENTROPY_SHORT_CHUNK_INTERLEAVED_IDENTIFIER,
    REPEATED_OPAQUE_IDENTIFIER,
    PAIRED_OPAQUE_IDENTIFIER,
    LOWERCASE_OPAQUE_IDENTIFIER,
    SINGLE_CHARACTER_INTERLEAVED_LOWERCASE_OPAQUE_IDENTIFIER,
    SHORT_SEGMENTED_OPAQUE_IDENTIFIER,
    PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER,
    VARIABLE_PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER,
    NEARLY_REPEATED_LOW_ENTROPY_INTERLEAVED_IDENTIFIER,
    TWO_PADDING_ONE_OPAQUE_INTERLEAVED_IDENTIFIER,
    HYPHEN_SPLIT_LOWERCASE_OPAQUE_IDENTIFIER,
    THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    DISTINCT_DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    TWO_SINGLETON_PADDING_OPAQUE_IDENTIFIER,
    DISTINCT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER,
    DISTINCT_SHORT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER,
    DISTINCT_ADJACENT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER,
    LONG_PERIODIC_PADDING_OPAQUE_IDENTIFIER,
    EIGHT_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    DECIMAL_CHARACTER_CODE_OPAQUE_IDENTIFIER,
    SEMANTIC_LOOKING_OPAQUE_IDENTIFIER
  ]) {
    const paddedProjectId = `fixture/${identifier}`;
    const paddedConfig = projectConfig();
    paddedConfig.project_id = paddedProjectId;
    const paddedProject = backend({ config: paddedConfig, projectId: paddedProjectId, submitter });
    const paddedProjectResult = await paddedProject.backend.create({
      document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
      content_kind: 'document', content: safeDocument()
    });
    assert.equal(paddedProjectResult.status, 'submission_safety_blocked', identifier);
    assert.equal(paddedProjectResult.errors?.[0]?.code, 'high_entropy_credential', identifier);
    assert.equal(paddedProjectResult.project_id, null, identifier);

    const paddedLogical = backend({ submitter });
    const paddedLogicalResult = await paddedLogical.backend.create({
      document_type: 'plan', logical_id: identifier, base_revision: 0,
      content_kind: 'document', content: safeDocument()
    });
    assert.equal(paddedLogicalResult.status, 'submission_safety_blocked', identifier);
    assert.equal(paddedLogicalResult.errors?.[0]?.code, 'high_entropy_credential', identifier);
    assert.equal(JSON.stringify(paddedLogicalResult).includes(identifier), false, identifier);
  }

  const denseFourCharacterConfig = projectConfig();
  const denseFourCharacterProjectId = `fixture/${DENSE_FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER}`;
  denseFourCharacterConfig.project_id = denseFourCharacterProjectId;
  const denseFourCharacterFixture = backend({
    config: denseFourCharacterConfig,
    projectId: denseFourCharacterProjectId,
    submitter
  });
  const denseFourCharacterResult = await denseFourCharacterFixture.backend.create({
    document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(denseFourCharacterResult.status, 'submission_safety_blocked');
  assert.equal(denseFourCharacterResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(denseFourCharacterResult.project_id, null);
  assert.equal(JSON.stringify(denseFourCharacterResult).includes(denseFourCharacterProjectId), false);

  const longPeriodicConfig = projectConfig();
  longPeriodicConfig.project_id = LONG_PERIODIC_PADDING_PROJECT_IDENTIFIER;
  const longPeriodicFixture = backend({
    config: longPeriodicConfig,
    projectId: LONG_PERIODIC_PADDING_PROJECT_IDENTIFIER,
    submitter
  });
  const longPeriodicResult = await longPeriodicFixture.backend.create({
    document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(longPeriodicResult.status, 'submission_safety_blocked');
  assert.equal(longPeriodicResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(longPeriodicResult.project_id, null);
  assert.equal(JSON.stringify(longPeriodicResult).includes(LONG_PERIODIC_PADDING_PROJECT_IDENTIFIER), false);

  const fullwidthConfig = projectConfig();
  fullwidthConfig.project_id = FULLWIDTH_OPAQUE_PROJECT_IDENTIFIER;
  const fullwidthFixture = backend({
    config: fullwidthConfig,
    projectId: FULLWIDTH_OPAQUE_PROJECT_IDENTIFIER,
    submitter
  });
  const fullwidthResult = await fullwidthFixture.backend.create({
    document_type: 'plan', logical_id: 'safe-plan', base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });
  assert.equal(fullwidthResult.status, 'submission_safety_blocked');
  assert.equal(fullwidthResult.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(fullwidthResult.project_id, null);
  assert.equal(JSON.stringify(fullwidthResult).includes(FULLWIDTH_OPAQUE_PROJECT_IDENTIFIER), false);
  assert.equal(submissions.length, 0);
});

test('allows readable semantic logical IDs without granting arbitrary hyphen or padding exemptions', async () => {
  const submissions = [];
  const fixture = backend({
    submitter: {
      async submit(input) {
        submissions.push(input);
        return { ok: true, filename: 'fixture.md' };
      }
    }
  });

  for (const logicalId of [
    'company-project-wiki-external-docs',
    'workflow-orchestration-observability-validation',
    'document-runtime-security-validation',
    'workflow-router-v2-document-runtime-integration',
    'company-project-wiki-v2-external-docs',
    'release-2026-08-company-project-wiki-docs',
    'database-migration-backfill-safely',
    'feature-flag-rollout-observations',
    'skills-improvements-from-user-feedback',
    'design-unified-document-system',
    'doc-system-unification-summary',
    'build-cache-clean-retry',
    'alpha-bravo-delta-gamma-theta-omega',
    'api-sdk-cli-http-json-yaml-grpc-oauth',
    'tcp-udp-ipv4-ipv6-dns-tls-ssh-sftp',
    'go-rust-java-node-python-ruby-swift-kotlin',
    'transcription-synchronization-orchestration'
  ]) {
    const result = await fixture.backend.create({
      document_type: 'plan', logical_id: logicalId, base_revision: 0,
      content_kind: 'document', content: safeDocument()
    });

    assert.equal(result.status, 'submitted_pending_review', logicalId);
  }
  assert.equal(submissions.length, 17);
});

test('allows a normal nested GitLab project ID through the complete Wiki mutation path', async () => {
  const nestedConfig = projectConfig();
  nestedConfig.project_id = NESTED_READABLE_PROJECT_ID;
  const submissions = [];
  const fixture = backend({
    config: nestedConfig,
    pages: pagesFor(nestedConfig),
    projectId: NESTED_READABLE_PROJECT_ID,
    submitter: {
      async submit(input) {
        submissions.push(input);
        return { ok: true, filename: 'fixture.md' };
      }
    }
  });

  const result = await fixture.backend.create({
    document_type: 'plan', logical_id: 'company-project-wiki-external-docs', base_revision: 0,
    content_kind: 'document', content: safeDocument()
  });

  assert.equal(result.status, 'submitted_pending_review');
  assert.equal(result.project_id, NESTED_READABLE_PROJECT_ID);
  assert.equal(submissions.length, 1);
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

test('uses each exact Wiki config snapshot to gate single and batch mutations', async () => {
  const initialConfig = projectConfig({ autoSubmit: true });
  const cases = [
    {
      name: 'single mutation observes auto-submit disabled remotely',
      config: projectConfig({ autoSubmit: false }),
      invoke: (instance) => instance.create({
        document_type: 'plan', logical_id: 'snapshot-plan', base_revision: 0,
        content_kind: 'document', content: safeDocument()
      }),
      status: 'confirmation_required'
    },
    {
      name: 'batch mutation observes auto-submit disabled remotely',
      config: projectConfig({ autoSubmit: false }),
      invoke: (instance) => instance.mutateBatch([{
        operation: 'create', document_type: 'plan', logical_id: 'snapshot-batch-plan', base_revision: 0,
        content_kind: 'document', content: safeDocument()
      }]),
      status: 'confirmation_required'
    },
    {
      name: 'mutation observes documentation disabled remotely',
      config: projectConfig({ autoSubmit: true, enabled: false }),
      invoke: (instance) => instance.create({
        document_type: 'plan', logical_id: 'disabled-snapshot-plan', base_revision: 0,
        content_kind: 'document', content: safeDocument()
      }),
      status: 'documentation_disabled'
    }
  ];

  for (const item of cases) {
    let submitCalls = 0;
    const fixture = backend({
      config: initialConfig,
      pages: pagesFor(item.config),
      submitter: {
        async submit() {
          submitCalls += 1;
          return { ok: true, filename: 'unexpected.md' };
        }
      }
    });

    const result = await item.invoke(fixture.backend);

    assert.equal(result.status, item.status, item.name);
    assert.equal(submitCalls, 0, item.name);
    assert.deepEqual(fixture.qmd.exactCalls, [MANIFEST_URI, CONFIG_URI], item.name);
  }
});

test('blocks Unicode-obscured credentials before auto-submit can write an Inbox revision', async () => {
  const credential = 'aB3dE5fG7hJ9kLmNpQrStUvWxYz01234';
  const fullwidthCredential = credential.replace(/[A-Za-z0-9]/gu, (character) => {
    if (character >= '0' && character <= '9') return String.fromCodePoint(0xff10 + Number(character));
    if (character >= 'A' && character <= 'Z') return String.fromCodePoint(0xff21 + character.charCodeAt(0) - 'A'.charCodeAt(0));
    return String.fromCodePoint(0xff41 + character.charCodeAt(0) - 'a'.charCodeAt(0));
  });
  const zeroWidthInterleavedCredential = credential.split('').join('\u200b');

  for (const [name, value] of [
    ['NFKC fullwidth credential', fullwidthCredential],
    ['zero-width interleaved credential', zeroWidthInterleavedCredential]
  ]) {
    let submitCalls = 0;
    const fixture = backend({
      autoSubmit: true,
      serializeSafeDocument: async (content) => validateAndSerializeSafeDocument(content, '/retained-fixture/company-project', {
        sourceSimilarityGuard: async () => ({ ok: true })
      }),
      submitter: {
        async submit() {
          submitCalls += 1;
          return { ok: true, filename: 'unexpected.md' };
        }
      }
    });
    const content = safeDocument();
    content.sections[0].paragraphs = [`Do not submit this value: ${value}`];

    const result = await fixture.backend.create({
      document_type: 'plan',
      logical_id: 'unicode-safety-plan',
      base_revision: 0,
      content_kind: 'document',
      content
    });

    assert.equal(result.status, 'submission_safety_blocked', name);
    assert.equal(result.errors?.[0]?.code, 'high_entropy_credential', name);
    assert.equal(submitCalls, 0, name);
    assert.equal(JSON.stringify(result).includes(value), false, name);
    assert.equal(JSON.stringify(result).includes(credential), false, name);
  }
});
