import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeReference = 'horspowers:using-horspowers/references/document-runtime.md';
const dailyWorkflowSkills = [
  'brainstorming',
  'dispatching-parallel-agents',
  'document-management',
  'executing-plans',
  'finishing-a-development-branch',
  'requesting-code-review',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'writing-plans'
];

// This is deliberately an exact list.  Adding a directory or renaming a
// low-level implementation must not silently make a direct write acceptable.
const lowLevelWriteAllowlist = new Set([
  'lib/config-manager.js',
  'lib/docs-core.js',
  'lib/document-backends/local-docs-backend.mjs',
  'lib/inbox-submitter.mjs',
  'lib/project-initializer.mjs'
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(target);
    return [target];
  }));
  return paths.flat();
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

async function readRelative(file) {
  return readFile(path.join(repoRoot, file), 'utf8');
}

test('daily workflow skills route document operations through the shared runtime', async () => {
  for (const skill of dailyWorkflowSkills) {
    const file = `skills/${skill}/SKILL.md`;
    const content = await readRelative(file);
    assert.match(content, new RegExp(runtimeReference.replaceAll('.', '\\.'), 'u'), file);
    assert.doesNotMatch(content, /\.horspowers-config\.yaml/u, `${file} must not select a document backend from a local marker`);
    assert.doesNotMatch(content, /(?:DocsCore|UnifiedDocsManager|lib\/docs-core\.js)/u, `${file} must not instantiate docs-core directly`);
    assert.doesNotMatch(content, /(?:find|cat|echo\s*>>|mv)\b[^\n]*(?:docs\/(?:plans|active|archive))/u, `${file} must not directly operate legacy document paths`);
  }
});

test('runtime reference documents JSON stdin contract, safe documents, and all result states', async () => {
  const content = await readRelative('skills/using-horspowers/references/document-runtime.md');
  for (const action of ['resolve', 'get', 'search', 'create', 'update', 'archive', 'restore', 'config-change', 'record-session']) {
    assert.match(content, new RegExp(`\\b${action}\\b`, 'u'), `missing action: ${action}`);
  }
  for (const status of [
    'confirmation_required',
    'safe_document_required',
    'submitted_pending_review',
    'partially_submitted',
    'submission_safety_blocked',
    'unavailable'
  ]) {
    assert.match(content, new RegExp(`\\b${status}\\b`, 'u'), `missing result state: ${status}`);
  }
  assert.match(content, /safe-document/u);
  assert.match(content, /implementation_specs/u);
  assert.match(content, /stdin/u);
  assert.match(content, /argv/u);
});

test('read and write workflow contracts retain their workflow gates through runtime actions', async () => {
  const expectedActions = {
    'executing-plans': ['search', 'get'],
    'requesting-code-review': ['search', 'get'],
    'dispatching-parallel-agents': ['search', 'get'],
    'subagent-driven-development': ['search', 'get'],
    brainstorming: ['search', 'create', 'update'],
    'writing-plans': ['search', 'create', 'update'],
    'systematic-debugging': ['search', 'create', 'update'],
    'test-driven-development': ['create', 'update'],
    'finishing-a-development-branch': ['get', 'update', 'archive'],
    'document-management': ['resolve', 'get', 'search', 'create', 'update', 'archive', 'restore', 'config-change']
  };

  for (const [skill, actions] of Object.entries(expectedActions)) {
    const content = await readRelative(`skills/${skill}/SKILL.md`);
    for (const action of actions) {
      assert.match(content, new RegExp(`\\b${action}\\b`, 'u'), `${skill} missing runtime ${action}`);
    }
  }

  const brainstorming = await readRelative('skills/brainstorming/SKILL.md');
  const writingPlans = await readRelative('skills/writing-plans/SKILL.md');
  const tdd = await readRelative('skills/test-driven-development/SKILL.md');
  const review = await readRelative('skills/requesting-code-review/SKILL.md');
  const finishing = await readRelative('skills/finishing-a-development-branch/SKILL.md');
  assert.match(brainstorming, /spec-document-reviewer-prompt\.md/u);
  assert.match(writingPlans, /plan-document-reviewer-prompt\.md/u);
  assert.match(tdd, /RED-GREEN-REFACTOR/u);
  assert.match(review, /review/u);
  assert.match(finishing, /tests pass|测试通过/u);
});

test('repository audit rejects direct document writes outside the exact low-level allowlist', async () => {
  const roots = ['skills', 'commands', 'hooks', 'lib'];
  const files = (await Promise.all(roots.map((root) => walk(path.join(repoRoot, root))))).flat()
    .filter((file) => /(?:SKILL\.md|\.(?:mjs|js|sh|md))$/u.test(file));
  const violations = [];

  for (const file of files) {
    const rel = relative(file);
    const content = await readFile(file, 'utf8');
    const directDocumentMutation = /(?:writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?|mkdir(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|echo\s*>>|\bmv\b)[^\n]*(?:docs\/(?:plans|active|archive))/u;
    if (directDocumentMutation.test(content) && !lowLevelWriteAllowlist.has(rel)) {
      violations.push(rel);
    }
  }

  assert.deepEqual(violations, []);
});

test('upgrade entry is explicitly fail-closed for external-document projects', async () => {
  const upgradeSkill = await readRelative('skills/upgrade/SKILL.md');
  const upgradeCode = await readRelative('lib/version-upgrade.js');
  assert.match(upgradeSkill, /external_project_upgrade_disabled/u);
  assert.match(upgradeSkill, /外置配置注册/u);
  assert.match(upgradeCode, /identifyGitProject/u);
  assert.match(upgradeCode, /external_project_upgrade_disabled/u);
  assert.match(upgradeCode, /no_mutation/u);
});
