import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DocumentRuntime } from '../../lib/document-runtime.mjs';
import { readHostConfig } from '../../lib/host-config.mjs';
import { InboxSubmitter } from '../../lib/inbox-submitter.mjs';
import { classifyRepositoryRemotes } from '../../lib/project-identity.mjs';
import { resolveProjectContext } from '../../lib/project-context.mjs';
import { validateAndSerializeSafeDocument } from '../../lib/submission-safety.mjs';

const require = createRequire(import.meta.url);
const { VersionUpgrader } = require('../../lib/version-upgrade.js');
const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactsRoot = path.join(repoRoot, 'tests/.artifacts/wiki-docs');
const COLLECTION = 'fixture-company-wiki';
const ROOT_URI = `qmd://${COLLECTION}/projects/fixture-project`;
const REGISTRY_URI = `qmd://${COLLECTION}/projects/horspowers-registry.md`;
const CONFIG_URI = `${ROOT_URI}/horspowers-config.md`;
const MANIFEST_URI = `${ROOT_URI}/index.md`;
const ACTIVE_TASK_URI = `${ROOT_URI}/tasks/active-task.md`;
const COMPLETED_TASK_URI = `${ROOT_URI}/tasks/completed-task.md`;
const DEFAULT_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
let fixtureSequence = 0;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function runGit(root, args) {
  await execFileAsync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
}

async function retainedProject(name, remotes) {
  const root = path.join(artifactsRoot, `${Date.now()}-${process.pid}-${fixtureSequence += 1}-${name}`);
  await mkdir(root, { recursive: true });
  await runGit(root, ['init', '--quiet']);
  for (const { name: remoteName, url } of remotes) {
    await runGit(root, ['remote', 'add', remoteName, url]);
  }
  return root;
}

async function snapshotTree(root, relative = '') {
  const snapshot = [];
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.git') continue;
    const entryRelative = path.join(relative, entry.name);
    const target = path.join(root, entryRelative);
    if (entry.isDirectory()) {
      snapshot.push({ path: entryRelative, type: 'directory' });
      snapshot.push(...await snapshotTree(root, entryRelative));
    } else {
      snapshot.push({ path: entryRelative, type: 'file', sha256: sha256(await readFile(target)) });
    }
  }
  return snapshot;
}

function machinePage(marker, value, title = '# Fixture page') {
  return `${title}\n\n<!-- ${marker}:start -->\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n<!-- ${marker}:end -->\n`;
}

function machineValue(markdown, marker) {
  const pattern = '<!-- ' + marker + ':start -->\\n```json\\n([\\s\\S]+?)\\n```\\n<!-- ' + marker + ':end -->';
  const match = new RegExp(pattern, 'u').exec(markdown);
  assert.ok(match, `${marker} machine block must be present`);
  return JSON.parse(match[1]);
}

function safeDocument(title, detail = 'Describe the bounded behavior in concise original prose.') {
  return {
    schema_version: 1,
    format: 'safe-document',
    title,
    sections: [{
      heading: 'Summary',
      paragraphs: [detail],
      bullets: [],
      files: [],
      implementation_specs: [],
      commands: []
    }],
    references: []
  };
}

async function canonicalDocument(document) {
  const result = await validateAndSerializeSafeDocument(document, '/retained-fixture/e2e', {
    sourceSimilarityGuard: async () => ({ ok: true })
  });
  assert.equal(result.ok, true);
  return result.markdown;
}

function wikiConfig(fingerprint, autoSubmit, projectId = 'fixture/company-project') {
  return {
    schema_version: 1,
    project_id: projectId,
    project_fingerprint: fingerprint,
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

function localConfigValue() {
  return {
    version: '4.5.0',
    development_mode: 'team',
    branch_strategy: 'worktree',
    testing_strategy: 'tdd',
    completion_strategy: 'pr',
    documentation: { enabled: true }
  };
}

function localConfigText() {
  return [
    'version: 4.5.0',
    'development_mode: team',
    'branch_strategy: worktree',
    'testing_strategy: tdd',
    'completion_strategy: pr',
    'documentation:',
    '  enabled: true',
    ''
  ].join('\n');
}

function fakeQmd(pages) {
  const exactCalls = [];
  return {
    exactCalls,
    client: {
      async getExact(uri) {
        exactCalls.push(uri);
        if (!pages.has(uri)) return { ok: false, error_code: 'fixture_qmd_not_found' };
        return { ok: true, result: { content: [{ type: 'text', text: pages.get(uri) }] } };
      },
      async search() {
        return { ok: true, result: { structuredContent: { results: [] } } };
      }
    }
  };
}

/**
 * In-process Inbox receiver used through the real InboxSubmitter transport.
 * It captures the stdin bytes and never has a filesystem path to overwrite.
 */
function fakeInboxReceiver() {
  const calls = [];
  const failures = new Set();
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const chunks = [];
    stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stdin.once('finish', () => {
      queueMicrotask(() => {
        const callNumber = calls.length + 1;
        calls.push({
          command,
          args,
          options,
          payload: Buffer.concat(chunks).toString('utf8')
        });
        child.emit('close', failures.has(callNumber) ? 17 : 0);
      });
    });
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      queueMicrotask(() => child.emit('close', null));
      return true;
    };
    return child;
  };
  return {
    calls,
    spawnImpl,
    failNext(offset = 1) {
      failures.add(calls.length + offset);
    }
  };
}

function submissionMetadata(payload) {
  return machineValue(payload, 'horspowers-submission');
}

function proposedDocument(payload) {
  const marker = '## Proposed document\n\n';
  const index = payload.indexOf(marker);
  assert.notEqual(index, -1, 'submission must contain a proposed document');
  return payload.slice(index + marker.length);
}

function fixtureDocumentUri(documentType, logicalId) {
  return `${ROOT_URI}/${documentType}s/${logicalId}.md`;
}

function publishManifest(fixture) {
  fixture.pages.set(MANIFEST_URI, machinePage('horspowers-manifest', fixture.manifest, '# Fixture manifest'));
}

/**
 * Simulate the user's local review, Wiki-native admission, manifest update,
 * and subsequent qmd visibility. It intentionally keeps the Inbox record.
 */
function admitSubmission(fixture, submissionId) {
  const call = fixture.receiver.calls.find(candidate => submissionMetadata(candidate.payload).submission_id === submissionId);
  assert.ok(call, 'the requested submission must exist in the fake Inbox');
  const metadata = submissionMetadata(call.payload);
  const current = fixture.manifest.documents[metadata.logical_id] ?? null;
  const proposal = proposedDocument(call.payload);

  if (metadata.operation === 'archive' || metadata.operation === 'restore') {
    assert.ok(current, 'status transitions require an existing manifest entry');
    const transition = machineValue(proposal, 'horspowers-status-transition');
    assert.equal(transition.uri, current.uri);
    assert.equal(transition.content_sha256, current.content_sha256);
    assert.equal(transition.from_status, current.status);
    assert.equal(metadata.base_revision, current.revision);
    fixture.manifest.documents[metadata.logical_id] = {
      ...current,
      status: transition.to_status,
      revision: metadata.proposed_revision,
      updated_at: '2026-08-10T01:00:00Z'
    };
  } else if (metadata.operation === 'config-change') {
    const config = machineValue(proposal, 'horspowers-config');
    assert.equal(metadata.logical_id, 'horspowers-config');
    assert.ok(current, 'config changes require the fixed manifest entry');
    fixture.pages.set(CONFIG_URI, proposal);
    fixture.config = config;
    fixture.manifest.documents['horspowers-config'] = {
      ...current,
      revision: metadata.proposed_revision,
      content_sha256: sha256(proposal),
      updated_at: '2026-08-10T01:00:00Z'
    };
  } else {
    if (current) assert.equal(metadata.base_revision, current.revision);
    else assert.equal(metadata.base_revision, 0);
    const uri = current?.uri ?? fixtureDocumentUri(metadata.document_type, metadata.logical_id);
    fixture.pages.set(uri, proposal);
    fixture.manifest.documents[metadata.logical_id] = {
      document_type: metadata.document_type,
      uri,
      revision: metadata.proposed_revision,
      status: current?.status ?? 'active',
      content_sha256: sha256(proposal),
      updated_at: '2026-08-10T01:00:00Z'
    };
  }
  publishManifest(fixture);
}

function runtimeFor(fixture) {
  const FixtureInboxSubmitter = class extends InboxSubmitter {
    constructor(options) {
      super(options, {
        spawnImpl: fixture.receiver.spawnImpl,
        now: () => new Date('2026-08-10T01:02:03.004Z')
      });
    }
  };
  return new DocumentRuntime({
    resolveProjectContext: (input) => resolveProjectContext({
      ...input,
      dependencies: fixture.dependencies
    }),
    InboxSubmitter: FixtureInboxSubmitter
  });
}

async function makeWikiFixture({
  name = 'company-wiki-e2e',
  autoSubmit = true,
  mode = 'ready',
  projectId = 'fixture/company-project',
  remotes = [{ name: 'origin', url: 'git@gitlab.ugnas.com:platform/fixture-project.git' }]
} = {}) {
  const root = await retainedProject(name, remotes);
  const classified = classifyRepositoryRemotes(remotes);
  const fingerprint = classified.kind === 'company' ? classified.project_fingerprint : DEFAULT_FINGERPRINT;
  const config = wikiConfig(fingerprint, autoSubmit, projectId);
  const configPage = mode === 'invalid_config'
    ? '# Invalid fixture config\n'
    : machinePage('horspowers-config', config, '# Fixture config');
  const activeBody = await canonicalDocument(safeDocument('Active fixture task'));
  const completedBody = await canonicalDocument(safeDocument('Completed fixture task'));
  const manifest = {
    schema_version: 1,
    project_id: config.project_id,
    project_fingerprint: config.project_fingerprint,
    documents: {
      'horspowers-config': {
        document_type: 'config',
        uri: CONFIG_URI,
        revision: 7,
        status: 'active',
        content_sha256: sha256(configPage),
        updated_at: '2026-08-10T00:00:00Z'
      },
      'active-task': {
        document_type: 'task',
        uri: ACTIVE_TASK_URI,
        revision: 2,
        status: 'active',
        content_sha256: sha256(activeBody),
        updated_at: '2026-08-10T00:00:00Z'
      },
      'completed-task': {
        document_type: 'task',
        uri: COMPLETED_TASK_URI,
        revision: 3,
        status: 'completed',
        content_sha256: sha256(completedBody),
        updated_at: '2026-08-10T00:00:00Z'
      }
    }
  };
  const registry = {
    schema_version: 1,
    projects: mode === 'unregistered' ? {} : {
      [fingerprint]: { project_id: config.project_id, config_uri: CONFIG_URI }
    }
  };
  const pages = new Map([
    [CONFIG_URI, configPage],
    [MANIFEST_URI, machinePage('horspowers-manifest', manifest, '# Fixture manifest')],
    [ACTIVE_TASK_URI, activeBody],
    [COMPLETED_TASK_URI, completedBody]
  ]);
  if (mode !== 'unavailable') {
    const registryPage = mode === 'invalid_registry'
      ? machinePage('horspowers-registry', { ...registry, unexpected: true }, '# Invalid fixture registry')
      : machinePage('horspowers-registry', registry, '# Fixture registry');
    pages.set(REGISTRY_URI, registryPage);
  }

  // The bootstrap belongs to the host, not the company project. Keeping this
  // retained fixture outside the project also lets the source-similarity guard
  // exercise the same boundary as production.
  const home = path.join(artifactsRoot, `${path.basename(root)}-host-home`);
  const hostPath = path.join(home, '.config', 'horspowers', 'host.json');
  const hostConfig = {
    schema_version: 1,
    wiki: {
      transport: {
        kind: 'ssh-stdio-mcp',
        ssh_alias: 'fixturewiki',
        timeout_ms: 1_000,
        max_response_bytes: 256 * 1024
      },
      collection: COLLECTION,
      registry_uri: REGISTRY_URI,
      inbox: {
        command: path.join(root, 'fake-inbox-receiver'),
        timeout_ms: 1_000,
        max_payload_bytes: 256 * 1024
      }
    }
  };
  await mkdir(path.dirname(hostPath), { recursive: true });
  await writeFile(hostPath, JSON.stringify(hostConfig, null, 2), 'utf8');
  await writeFile(path.join(root, '.horspowers-config.yaml'), localConfigText(), 'utf8');

  const qmd = fakeQmd(pages);
  const receiver = fakeInboxReceiver();
  const localConfigReads = { count: 0 };
  const dependencies = {
    defaultHostConfigPath: () => hostPath,
    readHostConfig,
    createQmdClient: () => qmd.client,
    readConfigAtRoot: () => {
      localConfigReads.count += 1;
      return localConfigValue();
    },
    classifyConfigAtRoot: () => 'valid'
  };
  const fixture = {
    root,
    config,
    manifest,
    pages,
    qmd,
    receiver,
    dependencies,
    localConfigReads,
    createRequest(logicalId, title = 'Pending fixture design') {
      return {
        document_type: 'design',
        logical_id: logicalId,
        base_revision: 0,
        content_kind: 'document',
        content: safeDocument(title)
      };
    },
    updateRequest(logicalId, title = 'Updated fixture document') {
      const entry = this.manifest.documents[logicalId];
      return {
        document_type: entry.document_type,
        logical_id: logicalId,
        base_revision: entry.revision,
        content_kind: 'document',
        content: safeDocument(title)
      };
    },
    transitionRequest(operation, logicalId) {
      const entry = this.manifest.documents[logicalId];
      return {
        document_type: entry.document_type,
        logical_id: logicalId,
        base_revision: entry.revision,
        content_kind: 'status-transition',
        content: {
          uri: entry.uri,
          content_sha256: entry.content_sha256,
          from_status: entry.status,
          to_status: operation === 'archive' ? 'archived' : 'active'
        }
      };
    },
    configChangeRequest(autoSubmitValue = autoSubmit) {
      const content = clone(this.config);
      content.documentation.submission.auto_submit = autoSubmitValue;
      return {
        document_type: 'config',
        logical_id: 'horspowers-config',
        base_revision: this.manifest.documents['horspowers-config'].revision,
        content_kind: 'project-config',
        content
      };
    },
    admit(submissionId) {
      admitSubmission(this, submissionId);
    },
    freshRuntime() {
      return runtimeFor(this);
    }
  };
  fixture.runtime = fixture.freshRuntime();
  return fixture;
}

async function makeLocalFixture(name = 'ordinary-local-e2e') {
  const root = await retainedProject(name, [
    { name: 'origin', url: 'https://github.com/example/ordinary-project.git' }
  ]);
  await writeFile(path.join(root, '.horspowers-config.yaml'), localConfigText(), 'utf8');
  const localConfigReads = { count: 0 };
  const dependencies = {
    readConfigAtRoot: () => {
      localConfigReads.count += 1;
      return localConfigValue();
    },
    classifyConfigAtRoot: () => 'valid'
  };
  const runtime = new DocumentRuntime({
    resolveProjectContext: (input) => resolveProjectContext({ ...input, dependencies })
  });
  return { root, runtime, localConfigReads };
}

test('company Wiki submissions remain unavailable until a local reviewer admits the Inbox revision', async () => {
  const fixture = await makeWikiFixture();
  const before = await snapshotTree(fixture.root);
  const resolution = await fixture.runtime.resolve(fixture.root);
  assert.equal(resolution.status, 'ready');
  assert.equal(resolution.backend, 'wiki');
  assert.equal(resolution.config_source, 'wiki');
  assert.equal(fixture.localConfigReads.count, 0, 'residual local config must not be read');

  const created = await fixture.runtime.execute({
    cwd: fixture.root,
    action: 'create',
    request: fixture.createRequest('pending-design')
  });

  assert.equal(created.status, 'submitted_pending_review');
  assert.equal(fixture.receiver.calls.length, 1);
  assert.equal(fixture.receiver.calls[0].options.shell, false);
  assert.equal(fixture.receiver.calls[0].args.length, 1);
  assert.match(fixture.receiver.calls[0].payload, /# Horspowers Inbox Submission/u);
  assert.deepEqual(await snapshotTree(fixture.root), before);

  const beforeAdmission = await fixture.freshRuntime().execute({
    cwd: fixture.root,
    action: 'get',
    request: { logical_id: 'pending-design' }
  });
  assert.equal(beforeAdmission.status, 'document_not_found');

  fixture.admit(created.submission_id);
  const afterAdmission = await fixture.freshRuntime().execute({
    cwd: fixture.root,
    action: 'get',
    request: { logical_id: 'pending-design' }
  });
  assert.equal(afterAdmission.status, 'ok');
  assert.equal(afterAdmission.document.revision, 1);
  assert.match(afterAdmission.document.content, /Pending fixture design/u);
  assert.deepEqual(await snapshotTree(fixture.root), before);
});

test('company remote variants share one fingerprint while suffix impersonation stays external', () => {
  const companyUrls = [
    'git@gitlab.ugnas.com:platform/fixture-project.git',
    'ssh://git@gitlab.ugnas.com/platform/fixture-project.git',
    'https://gitlab.ugnas.com/platform/fixture-project.git',
    'git@192.168.75.113:platform/fixture-project.git',
    'ssh://git@192.168.75.113:2222/platform/fixture-project.git'
  ];
  const identities = companyUrls.map(url => classifyRepositoryRemotes([{ name: 'origin', url }]));
  assert.equal(new Set(identities.map(identity => identity.project_fingerprint)).size, 1);
  assert.equal(identities[0].canonical_repository, 'ugnas-gitlab/platform/fixture-project');

  for (const url of [
    'https://gitlab.ugnas.com.evil.example/platform/fixture-project.git',
    'git@192.168.75.113.example:platform/fixture-project.git'
  ]) {
    assert.equal(classifyRepositoryRemotes([{ name: 'origin', url }]).kind, 'external');
  }
});

test('unavailable, unregistered, invalid, and ambiguous company contexts never create local documents', async () => {
  const scenarios = [
    ['unavailable', 'wiki_unavailable', undefined],
    ['unregistered', 'unregistered_company_project', undefined],
    ['invalid_registry', 'registry_invalid', undefined],
    ['invalid_config', 'project_config_invalid', undefined],
    ['ambiguous', 'ambiguous_company_remote', [
      { name: 'upstream', url: 'git@gitlab.ugnas.com:platform/one.git' },
      { name: 'backup', url: 'git@192.168.75.113:platform/two.git' }
    ]]
  ];

  for (const [mode, expectedStatus, remotes] of scenarios) {
    const fixture = await makeWikiFixture({ name: `no-fallback-${mode}`, mode, ...(remotes ? { remotes } : {}) });
    const before = await snapshotTree(fixture.root);
    const result = await fixture.runtime.execute({
      cwd: fixture.root,
      action: 'create',
      request: fixture.createRequest(`blocked-${mode}`)
    });

    assert.equal(result.status, expectedStatus, mode);
    assert.equal(fixture.receiver.calls.length, 0, mode);
    assert.equal(fixture.localConfigReads.count, 0, mode);
    assert.deepEqual(await snapshotTree(fixture.root), before, mode);
  }
});

test('the one auto-submit policy governs every mutation and transitions preserve body identity', async () => {
  const automatic = await makeWikiFixture({ name: 'auto-submit-all-operations', autoSubmit: true });
  const beforeAutomatic = await snapshotTree(automatic.root);

  const created = await automatic.runtime.execute({
    cwd: automatic.root,
    action: 'create',
    request: automatic.createRequest('auto-created-design')
  });
  assert.equal(created.status, 'submitted_pending_review');
  automatic.admit(created.submission_id);

  const updated = await automatic.runtime.execute({
    cwd: automatic.root,
    action: 'update',
    request: automatic.updateRequest('active-task', 'Updated active task')
  });
  assert.equal(updated.status, 'submitted_pending_review');
  automatic.admit(updated.submission_id);

  const beforeArchive = clone(automatic.manifest.documents['active-task']);
  const archive = await automatic.runtime.execute({
    cwd: automatic.root,
    action: 'archive',
    request: automatic.transitionRequest('archive', 'active-task')
  });
  assert.equal(archive.status, 'submitted_pending_review');
  const archivePayload = automatic.receiver.calls.at(-1).payload;
  assert.match(proposedDocument(archivePayload), /horspowers-status-transition:start/u);
  assert.equal(proposedDocument(archivePayload).includes(automatic.pages.get(beforeArchive.uri)), false);
  automatic.admit(archive.submission_id);
  const archived = automatic.manifest.documents['active-task'];
  assert.equal(archived.status, 'archived');
  assert.equal(archived.uri, beforeArchive.uri);
  assert.equal(archived.content_sha256, beforeArchive.content_sha256);
  assert.equal(automatic.pages.get(archived.uri), automatic.pages.get(beforeArchive.uri));

  const restore = await automatic.runtime.execute({
    cwd: automatic.root,
    action: 'restore',
    request: automatic.transitionRequest('restore', 'active-task')
  });
  assert.equal(restore.status, 'submitted_pending_review');
  automatic.admit(restore.submission_id);
  const restored = automatic.manifest.documents['active-task'];
  assert.equal(restored.status, 'active');
  assert.equal(restored.uri, beforeArchive.uri);
  assert.equal(restored.content_sha256, beforeArchive.content_sha256);

  const invalidConfig = automatic.configChangeRequest();
  invalidConfig.content.documentation.root_uri = `qmd://${COLLECTION}/projects`;
  const callsBeforeInvalidConfig = automatic.receiver.calls.length;
  const rejectedConfig = await automatic.runtime.execute({
    cwd: automatic.root,
    action: 'config-change',
    request: invalidConfig
  });
  assert.equal(rejectedConfig.status, 'project_config_incompatible');
  assert.equal(automatic.receiver.calls.length, callsBeforeInvalidConfig);

  const changedConfig = await automatic.runtime.execute({
    cwd: automatic.root,
    action: 'config-change',
    request: automatic.configChangeRequest(false)
  });
  assert.equal(changedConfig.status, 'submitted_pending_review', JSON.stringify(changedConfig));
  assert.match(proposedDocument(automatic.receiver.calls.at(-1).payload), /horspowers-config:start/u);
  assert.equal(proposedDocument(automatic.receiver.calls.at(-1).payload).includes('# Fixture config'), false);
  automatic.admit(changedConfig.submission_id);
  assert.equal(automatic.manifest.documents['horspowers-config'].revision, 8);
  assert.equal(automatic.manifest.documents['horspowers-config'].content_sha256, sha256(automatic.pages.get(CONFIG_URI)));
  assert.equal(automatic.config.documentation.submission.auto_submit, false);
  const afterConfigAdmission = await automatic.freshRuntime().execute({
    cwd: automatic.root,
    action: 'create',
    request: automatic.createRequest('needs-confirmation')
  });
  assert.equal(afterConfigAdmission.status, 'confirmation_required');
  assert.deepEqual(
    automatic.receiver.calls.map(call => submissionMetadata(call.payload).operation),
    ['create', 'update', 'archive', 'restore', 'config-change']
  );
  assert.deepEqual(await snapshotTree(automatic.root), beforeAutomatic);

  const confirmed = await makeWikiFixture({ name: 'confirmation-all-operations', autoSubmit: false });
  const beforeConfirmed = await snapshotTree(confirmed.root);
  const assertConfirmation = async (action, request) => {
    const count = confirmed.receiver.calls.length;
    const waiting = await confirmed.runtime.execute({ cwd: confirmed.root, action, request });
    assert.equal(waiting.status, 'confirmation_required', action);
    assert.equal(confirmed.receiver.calls.length, count, action);
    const submitted = await confirmed.runtime.execute({ cwd: confirmed.root, action, request, confirmed: true });
    assert.equal(submitted.status, 'submitted_pending_review', action);
    return submitted;
  };

  const gatedCreate = await assertConfirmation('create', confirmed.createRequest('confirmed-design'));
  confirmed.admit(gatedCreate.submission_id);
  const gatedUpdate = await assertConfirmation('update', confirmed.updateRequest('active-task'));
  confirmed.admit(gatedUpdate.submission_id);
  const gatedArchive = await assertConfirmation('archive', confirmed.transitionRequest('archive', 'active-task'));
  confirmed.admit(gatedArchive.submission_id);
  const gatedRestore = await assertConfirmation('restore', confirmed.transitionRequest('restore', 'active-task'));
  confirmed.admit(gatedRestore.submission_id);
  await assertConfirmation('config-change', confirmed.configChangeRequest(false));
  assert.deepEqual(await snapshotTree(confirmed.root), beforeConfirmed);
});

test('a disabled Wiki document backend still permits the config-change needed to re-enable it', async () => {
  const fixture = await makeWikiFixture({ name: 'disabled-wiki-config-change', autoSubmit: true });
  fixture.config.documentation.enabled = false;
  const disabledConfigPage = machinePage('horspowers-config', fixture.config, '# Fixture config');
  fixture.pages.set(CONFIG_URI, disabledConfigPage);
  fixture.manifest.documents['horspowers-config'] = {
    ...fixture.manifest.documents['horspowers-config'],
    content_sha256: sha256(disabledConfigPage)
  };
  publishManifest(fixture);
  const before = await snapshotTree(fixture.root);

  const disabledResolution = await fixture.freshRuntime().resolve(fixture.root);
  assert.equal(disabledResolution.status, 'documentation_disabled');
  const blockedCreate = await fixture.freshRuntime().execute({
    cwd: fixture.root,
    action: 'create',
    request: fixture.createRequest('must-stay-disabled')
  });
  assert.equal(blockedCreate.status, 'documentation_disabled');

  const request = fixture.configChangeRequest();
  request.content.documentation.enabled = true;
  const submitted = await fixture.freshRuntime().execute({
    cwd: fixture.root,
    action: 'config-change',
    request
  });

  assert.equal(submitted.status, 'submitted_pending_review');
  assert.equal(submissionMetadata(fixture.receiver.calls.at(-1).payload).operation, 'config-change');
  assert.deepEqual(await snapshotTree(fixture.root), before);

  fixture.admit(submitted.submission_id);
  const restoredResolution = await fixture.freshRuntime().resolve(fixture.root);
  assert.equal(restoredResolution.status, 'ready');
  assert.equal(restoredResolution.backend, 'wiki');
});

function sessionRequest() {
  return {
    session: {
      session_id: 'fixture-session-id',
      ended_at: '2026-08-10T01:00:00Z',
      branch: 'feat/external-docs'
    },
    document_refs: [{ document_type: 'task', logical_id: 'completed-task' }],
    auto_archive_completed: true
  };
}

test('record-session has one confirmation boundary and reports each partial Inbox failure', async () => {
  const gated = await makeWikiFixture({ name: 'record-session-confirmation', autoSubmit: false });
  const beforeGated = await snapshotTree(gated.root);
  const waiting = await gated.runtime.execute({
    cwd: gated.root,
    action: 'record-session',
    request: sessionRequest()
  });
  assert.equal(waiting.status, 'confirmation_required');
  assert.equal(waiting.previews.length, 3, 'session, document progress, and archive are one confirmation batch');
  assert.equal(gated.receiver.calls.length, 0);

  const submitted = await gated.runtime.execute({
    cwd: gated.root,
    action: 'record-session',
    request: sessionRequest(),
    confirmed: true
  });
  assert.equal(submitted.status, 'submitted_pending_review');
  assert.equal(submitted.submissions.length, 3);
  assert.deepEqual(
    gated.receiver.calls.map(call => submissionMetadata(call.payload).operation),
    ['create', 'update', 'archive']
  );
  assert.deepEqual(await snapshotTree(gated.root), beforeGated);

  const partial = await makeWikiFixture({ name: 'record-session-partial', autoSubmit: true });
  const beforePartial = await snapshotTree(partial.root);
  partial.receiver.failNext(2);
  const result = await partial.runtime.execute({
    cwd: partial.root,
    action: 'record-session',
    request: sessionRequest()
  });
  assert.equal(result.status, 'partially_submitted');
  assert.equal(result.submissions.length, 1);
  assert.equal(result.submissions[0].operation, 'create');
  assert.equal(result.failures.length, 2);
  assert.deepEqual(result.failures.map(failure => failure.operation), ['update', 'archive']);
  assert.equal(result.failures[0].error_code, 'inbox_process_exit');
  assert.equal(result.failures[1].error_code, 'submission_dependency_failed');
  assert.equal(partial.receiver.calls.length, 2, 'dependent archive must not be sent after a failed update');
  assert.deepEqual(await snapshotTree(partial.root), beforePartial);
});

test('unsafe body carriers and failed Inbox delivery never fall back to local docs', async () => {
  const fixture = await makeWikiFixture({ name: 'submission-safety-e2e', autoSubmit: true });
  const before = await snapshotTree(fixture.root);
  const cases = [
    ['private-key', (content) => { content.sections[0].paragraphs = ['-----BEGIN PRIVATE KEY-----']; }],
    ['authorization', (content) => { content.sections[0].paragraphs = ['Authorization: Bearer fixture-secret']; }],
    ['bare-token', (content) => { content.sections[0].paragraphs = ['aB3dE5fG7hJ9kLmNpQrStUvWxYz01234']; }],
    ['source', (content) => { content.sections[0].paragraphs = ['function leaked(value) { return value; }']; }],
    ['log', (content) => {
      content.sections[0].paragraphs = ['2026-08-10T01:00:00Z first entry', '2026-08-10T01:00:01Z second entry'];
    }],
    ['diff', (content) => { content.sections[0].paragraphs = ['@@ -1,1 +1,1 @@']; }],
    ['raw-markdown', (content) => { content.sections[0].paragraphs = ['# copied markdown heading']; }],
    ['absolute-path', (content) => { content.sections[0].files = [{ operation: 'modify', path: '/private/fixture.js' }]; }],
    ['external-url', (content) => { content.sections[0].paragraphs = ['https://example.invalid/fixture']; }],
    ['unmodeled-body', (content) => { content.body = 'unmodeled body'; }]
  ];

  for (const [name, mutate] of cases) {
    const request = fixture.createRequest(`unsafe-${name}`);
    mutate(request.content);
    const calls = fixture.receiver.calls.length;
    const result = await fixture.runtime.execute({ cwd: fixture.root, action: 'create', request });
    assert.ok(
      ['safe_document_required', 'submission_safety_blocked', 'raw_source_detected', 'source_scan_incomplete'].includes(result.status),
      name
    );
    assert.equal(fixture.receiver.calls.length, calls, name);
    assert.deepEqual(await snapshotTree(fixture.root), before, name);
  }

  fixture.receiver.failNext();
  const failed = await fixture.runtime.execute({
    cwd: fixture.root,
    action: 'create',
    request: fixture.createRequest('transport-failure')
  });
  assert.equal(failed.status, 'submission_failed');
  assert.equal(failed.error_code, 'inbox_process_exit');
  const transportCall = fixture.receiver.calls.at(-1);
  assert.equal(transportCall.options.shell, false);
  assert.match(transportCall.payload, /# Horspowers Inbox Submission/u);
  assert.deepEqual(await snapshotTree(fixture.root), before);
});

test('a high-entropy project ID cannot enter Inbox even when Registry and config bind it', async () => {
  const token = 'aB3dE5fG7hJ9kLmNpQrStUvWxYz01234';
  const fixture = await makeWikiFixture({
    name: 'high-entropy-project-id',
    projectId: `fixture/${token}`
  });
  const before = await snapshotTree(fixture.root);

  const result = await fixture.runtime.execute({
    cwd: fixture.root,
    action: 'config-change',
    request: fixture.configChangeRequest()
  });

  assert.equal(result.status, 'submission_safety_blocked');
  assert.equal(result.errors?.[0]?.code, 'high_entropy_credential');
  assert.equal(fixture.receiver.calls.length, 0);
  assert.deepEqual(await snapshotTree(fixture.root), before);
});

test('company upgrades remain mutation-free while an ordinary Git project keeps local documentation behavior', async () => {
  const company = await makeWikiFixture({ name: 'company-upgrade-no-mutation' });
  await mkdir(path.join(company.root, 'document-driven-ai-workflow'), { recursive: true });
  await writeFile(path.join(company.root, '.horspowers-version'), '4.1.0\n', 'utf8');
  await writeFile(path.join(company.root, 'document-driven-ai-workflow', 'legacy.md'), '# Legacy fixture\n', 'utf8');
  const companyBefore = await snapshotTree(company.root);
  const companyUpgrade = new VersionUpgrader(company.root);
  const companyResult = await companyUpgrade.run({ quiet: true, skipDDAW: true, skipDocs: true });
  assert.equal(companyResult.status, 'external_project_upgrade_disabled');
  assert.equal(companyResult.no_mutation, true);
  assert.deepEqual(await snapshotTree(company.root), companyBefore);

  const ordinary = await makeLocalFixture();
  const ordinaryBefore = await snapshotTree(ordinary.root);
  const created = await ordinary.runtime.execute({
    cwd: ordinary.root,
    action: 'create',
    request: {
      document_type: 'task',
      title: 'Ordinary local runtime task',
      content: '# Ordinary local runtime task\n\n## 基本信息\n- 状态: 待开始\n\n## 进展记录\n- 2026-08-10: created\n'
    }
  });
  assert.equal(created.status, 'created');
  assert.equal(created.backend, 'local');
  assert.ok(ordinary.localConfigReads.count > 0);
  const ordinaryAfterCreate = await snapshotTree(ordinary.root);
  assert.notDeepEqual(ordinaryAfterCreate, ordinaryBefore);
  assert.ok(ordinaryAfterCreate.some(entry => entry.path.startsWith(path.join('docs', 'active'))));

  await mkdir(path.join(ordinary.root, 'document-driven-ai-workflow'), { recursive: true });
  await writeFile(path.join(ordinary.root, '.horspowers-version'), '4.1.0\n', 'utf8');
  const ordinaryUpgrade = new VersionUpgrader(ordinary.root);
  const ordinaryResult = await ordinaryUpgrade.run({ quiet: true, skipDDAW: true, skipDocs: true });
  assert.equal(ordinaryResult.success, true);
  assert.notEqual(await readFile(path.join(ordinary.root, '.horspowers-version'), 'utf8'), '4.1.0\n');
});
