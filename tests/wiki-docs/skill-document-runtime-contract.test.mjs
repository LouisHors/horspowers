import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DOCUMENT_RUNTIME_RESULT_STATUSES } from '../../lib/document-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);
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

// Task 7 has not migrated this hook to DocumentRuntime yet.  This exception
// is intentionally a single file with a bounded legacy-operation inventory;
// it does not make any other hook, extension, or indirect path acceptable.
const temporaryLegacyDocumentExceptions = new Map([
  ['hooks/session-end.sh', {
    reason: 'Task 7 session-end migration is pending; its company-project early exit remains mandatory.',
    operationIds: new Set([
      'legacy-docs-discovery',
      'shell-document-append',
      'metadata-directory-write',
      'metadata-file-write',
      'node-fs-mutation',
      'docs-core-archive'
    ])
  }]
]);

const runtimeTextExtensions = new Set([
  '.bash', '.c', '.cc', '.cjs', '.cmd', '.coffee', '.cpp', '.cs', '.fish',
  '.go', '.h', '.java', '.js', '.json', '.jsx', '.lua', '.mjs', '.php',
  '.pl', '.ps1', '.py', '.rb', '.rs', '.sh', '.swift', '.toml', '.ts',
  '.tsx', '.yaml', '.yml', '.zsh'
]);
const ignoredAuditDirectories = new Set(['.git', '.worktrees', 'coverage', 'node_modules']);
const nodeFsMutationMethods = new Set([
  'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'createWriteStream',
  'fchmod', 'fchown', 'ftruncate', 'link', 'lchmod', 'lchown', 'lutimes',
  'mkdir', 'mkdtemp', 'open', 'rename', 'rm', 'rmdir', 'symlink', 'truncate',
  'unlink', 'utimes', 'write', 'writeFile', 'writev'
]);
const nodeFsMutationMethodPattern = [...nodeFsMutationMethods]
  .flatMap((method) => [method, `${method}Sync`])
  .sort((left, right) => right.length - left.length)
  .join('|');

const legacyDocumentOperationPatterns = [
  ['legacy-docs-discovery', /\bfind\b[^\n]*(?:\$\{?[^}\n]*(?:doc|metadata)[^}\n]*\}?|(?:^|[\s"'`])docs\/)/iu],
  ['shell-document-append', />>\s*["']?\$\{?[^}\n]*(?:doc|metadata)[^}\n]*\}?/iu],
  ['metadata-directory-write', /\bmkdir(?:Sync)?\b[^\n]*(?:\$\{?[^}\n]*(?:doc|metadata)[^}\n]*\}?|(?:^|[\s"'`])docs\/)/iu],
  ['metadata-file-write', /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?)\s*\([\s\S]{0,240}?(?:\$\{?[^}\n]*(?:doc|metadata)[^}\n]*\}?|(?:^|[\s"'`])docs\/)/iu],
  ['docs-core-archive', /\bnode\b[^\n]*(?:docs[_-]?core|docs-core\.js)[^\n]*\barchive\b/iu]
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredAuditDirectories.has(entry.name) ? [] : walk(target);
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

function isKnownRuntimeTextRelativePath(rel) {
  if (rel === 'tests' || rel.startsWith('tests/')) return false;
  const name = path.basename(rel);
  if (name === 'SKILL.md' || rel.startsWith('commands/') || rel.startsWith('agents/')) return true;
  return runtimeTextExtensions.has(path.extname(name).toLocaleLowerCase('en-US'));
}

async function isRuntimeTextPath(file) {
  const rel = relative(file);
  if (isKnownRuntimeTextRelativePath(rel)) return true;
  if (rel === 'tests' || rel.startsWith('tests/')) return false;
  return ((await stat(file)).mode & 0o111) !== 0;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isNodeFsMutationMethod(method) {
  return nodeFsMutationMethods.has(method) ||
    (method.endsWith('Sync') && nodeFsMutationMethods.has(method.slice(0, -4)));
}

function destructuredNodeFsBindings(content, pattern, moduleBindings, directMutationBindings) {
  for (const match of content.matchAll(pattern)) {
    for (const part of match[1].split(',')) {
      const binding = /^\s*([A-Za-z_$][\w$]*)(?:\s*(?::|\bas\b)\s*([A-Za-z_$][\w$]*))?\s*$/u.exec(part);
      if (!binding) continue;
      const [, imported, local = imported] = binding;
      if (imported === 'promises') moduleBindings.add(local);
      if (isNodeFsMutationMethod(imported)) directMutationBindings.add(local);
    }
  }
}

function hasNodeFsMutation(content) {
  const nodeFsModule = String.raw`(?:node:)?fs(?:/promises)?`;
  const moduleBindings = new Set();
  const directMutationBindings = new Set();

  for (const match of content.matchAll(new RegExp(
    String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]${nodeFsModule}['"]\s*\)`,
    'gu'
  ))) moduleBindings.add(match[1]);
  for (const match of content.matchAll(new RegExp(
    String.raw`\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+['"]${nodeFsModule}['"]`,
    'gu'
  ))) moduleBindings.add(match[1]);

  const cjsDestructure = new RegExp(
    String.raw`\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*['"]${nodeFsModule}['"]\s*\)`,
    'gu'
  );
  const esmDestructure = new RegExp(
    String.raw`\bimport\s*\{([^}]+)\}\s*from\s*['"]${nodeFsModule}['"]`,
    'gu'
  );
  destructuredNodeFsBindings(content, cjsDestructure, moduleBindings, directMutationBindings);
  destructuredNodeFsBindings(content, esmDestructure, moduleBindings, directMutationBindings);

  const methodProperty = String.raw`(?:(?:\.|\?\.)\s*(?:${nodeFsMutationMethodPattern})|\[\s*['"](?:${nodeFsMutationMethodPattern})['"]\s*\])`;
  const directRequireAlias = new RegExp(
    String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]${nodeFsModule}['"]\s*\)\s*${methodProperty}`,
    'gu'
  );
  for (const match of content.matchAll(directRequireAlias)) directMutationBindings.add(match[1]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of [...moduleBindings]) {
      const aliasPattern = new RegExp(
        String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${escapeRegex(binding)}\s*(?:\.|\?\.)\s*promises\b`,
        'gu'
      );
      for (const match of content.matchAll(aliasPattern)) {
        if (!moduleBindings.has(match[1])) {
          moduleBindings.add(match[1]);
          changed = true;
        }
      }
    }
  }

  const methodInvocation = String.raw`${methodProperty}\s*(?:(?:\?\.)?\s*\(|(?:\.|\?\.)\s*(?:apply|bind|call)\s*\()`;
  const memberPath = String.raw`(?:\s*(?:\.|\?\.)\s*[A-Za-z_$][\w$]*)*`;
  if (new RegExp(String.raw`require\(\s*['"]${nodeFsModule}['"]\s*\)(?:\s*(?:\.|\?\.)\s*promises)?\s*${methodInvocation}`, 'u').test(content)) {
    return true;
  }
  for (const binding of moduleBindings) {
    if (new RegExp(String.raw`\b${escapeRegex(binding)}${memberPath}\s*${methodInvocation}`, 'u').test(content)) return true;
    const aliasPattern = new RegExp(
      String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${escapeRegex(binding)}${memberPath}\s*${methodProperty}`,
      'gu'
    );
    for (const match of content.matchAll(aliasPattern)) directMutationBindings.add(match[1]);
  }
  for (const binding of directMutationBindings) {
    if (new RegExp(String.raw`\b${escapeRegex(binding)}\s*\(`, 'u').test(content)) return true;
  }
  return false;
}

function legacyDocumentOperations(content, { includeNodeFsMutations = true } = {}) {
  const operations = legacyDocumentOperationPatterns
    .filter(([, pattern]) => pattern.test(content))
    .map(([id]) => id);
  if (includeNodeFsMutations && hasNodeFsMutation(content)) operations.push('node-fs-mutation');
  return operations;
}

function isNodeFsMutationAuditCandidate(rel) {
  return rel.startsWith('scripts/') || rel === 'hooks/session-end.sh';
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

test('runtime reference documents JSON stdin contract, safe documents, and the runtime status catalog', async () => {
  const content = await readRelative('skills/using-horspowers/references/document-runtime.md');
  for (const action of ['resolve', 'get', 'search', 'create', 'update', 'archive', 'restore', 'config-change', 'record-session']) {
    assert.match(content, new RegExp(`\\b${action}\\b`, 'u'), `missing action: ${action}`);
  }
  assert.ok(DOCUMENT_RUNTIME_RESULT_STATUSES.includes('invalid_request'));
  assert.ok(DOCUMENT_RUNTIME_RESULT_STATUSES.includes('context_unavailable'));
  assert.ok(DOCUMENT_RUNTIME_RESULT_STATUSES.includes('documentation_disabled'));
  assert.ok(DOCUMENT_RUNTIME_RESULT_STATUSES.includes('wiki_backend_unavailable'));
  assert.equal(new Set(DOCUMENT_RUNTIME_RESULT_STATUSES).size, DOCUMENT_RUNTIME_RESULT_STATUSES.length);
  for (const status of DOCUMENT_RUNTIME_RESULT_STATUSES) {
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
  const subagentDevelopment = await readRelative('skills/subagent-driven-development/SKILL.md');
  assert.match(brainstorming, /spec-document-reviewer-prompt\.md/u);
  assert.match(writingPlans, /plan-document-reviewer-prompt\.md/u);
  assert.match(tdd, /RED-GREEN-REFACTOR/u);
  assert.match(review, /review/u);
  assert.match(finishing, /tests pass|测试通过/u);
  assert.match(subagentDevelopment, /全部任务完成后[\s\S]*最终全量 diff[\s\S]*独立.*code review/u);
  assert.match(subagentDevelopment, /blocking.*修复.*复审[\s\S]*finishing/u);
});

test('repository audit rejects direct document operations outside the exact allowlist or Task 7 exception', async () => {
  assert.equal(lowLevelWriteAllowlist.has('scripts/migrate-docs.js'), false);
  const allFiles = await walk(repoRoot);
  const textFlags = await Promise.all(allFiles.map(isRuntimeTextPath));
  const files = allFiles.filter((_, index) => textFlags[index]);
  const violations = [];

  for (const file of files) {
    const rel = relative(file);
    const content = await readFile(file, 'utf8');
    const operationIds = legacyDocumentOperations(content, {
      includeNodeFsMutations: isNodeFsMutationAuditCandidate(rel)
    });
    if (operationIds.length === 0 || lowLevelWriteAllowlist.has(rel)) continue;

    const exception = temporaryLegacyDocumentExceptions.get(rel);
    if (!exception) {
      violations.push({ file: rel, operationIds });
      continue;
    }

    assert.match(exception.reason, /Task 7/u, `${rel} exception must retain its migration reason`);
    assert.deepEqual(new Set(operationIds), exception.operationIds, `${rel} exception must not hide a new legacy operation`);
  }

  assert.deepEqual(violations, []);
});

test('audit recognizes indirect document variables and includes .cjs candidates', () => {
  assert.equal(isKnownRuntimeTextRelativePath('hooks/legacy-session.cjs'), true);
  const content = [
    'find "$project_docs_dir" -name "*.md"',
    'printf "%s" "$record" >> "$doc_path"',
    'mkdir -p "$metadata_dir"',
    'fs.writeFileSync(\n  `${metadata_dir}/last-session.json`, payload\n)',
    'node "$docs_core" archive "$doc_file"'
  ].join('\n');

  assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
    'legacy-docs-discovery',
    'shell-document-append',
    'metadata-directory-write',
    'metadata-file-write',
    'docs-core-archive'
  ]));

  assert.deepEqual(new Set(legacyDocumentOperations(
    'fs.mkdirSync(`${metadata_dir}/events`, { recursive: true });'
  )), new Set(['metadata-directory-write']));
});

test('audit recognizes Node fs mutations through generic CJS bindings and property paths', () => {
  assert.equal(isKnownRuntimeTextRelativePath('scripts/legacy-migration.cjs'), true);
  const content = [
    "const fileSystem = require('node:fs');",
    "const disk = require('fs');",
    'fileSystem.mkdirSync(path.dirname(rename.target), { recursive: true });',
    'fileSystem.renameSync(rename.source, rename.target);',
    'fileSystem.appendFileSync(merge.design, content);',
    'fileSystem.unlinkSync(merge.decision);',
    'disk.promises.writeFile(update.file, content);'
  ].join('\n');

  assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
    'node-fs-mutation'
  ]));
});

test('audit follows Node fs method aliases and static property access', () => {
  const cases = [
    [
      "const storage = require('node:fs');",
      "const save = storage['writeFileSync'];",
      'save(update.file, content);'
    ].join('\n'),
    [
      "const { mkdirSync: makeDirectory } = require('fs');",
      'makeDirectory(path.dirname(rename.target), { recursive: true });'
    ].join('\n'),
    [
      "const save = require('node:fs')['writeFileSync'];",
      "const target = path.join('docs', 'active', 'task.md');",
      'save(target, content);'
    ].join('\n'),
    [
      "import { createWriteStream as createWriter } from 'node:fs';",
      'createWriter(update.file);'
    ].join('\n')
  ];

  for (const content of cases) {
    assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
      'node-fs-mutation'
    ]));
  }
});

test('the only deferred legacy hook stays behind the company-project early-exit gate', async (t) => {
  assert.deepEqual([...temporaryLegacyDocumentExceptions.keys()], ['hooks/session-end.sh']);
  const content = await readRelative('hooks/session-end.sh');
  const gate = /if \[ "\$PROJECT_IDENTITY_KIND" = "company" \] \|\| \[ "\$PROJECT_IDENTITY_KIND" = "ambiguous_company_remote" \] \|\| \[ "\$PROJECT_IDENTITY_KIND" = "none" \]; then[\s\S]*?exit 0/u;
  assert.match(content, gate);
  assert.ok(content.search(gate) < content.search(/\bfind\b[^\n]*\$project_docs_dir/u));
  assert.ok(content.search(gate) < content.search(/>>\s*"\$doc_path"/u));
  assert.ok(content.search(gate) < content.search(/\bnode\b[^\n]*\$docs_core[^\n]*\barchive\b/u));

  const root = await mkdtemp(path.join(tmpdir(), 'horspowers-session-end-company-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet', root], { windowsHide: true });
  await execFileAsync('git', ['-C', root, 'remote', 'add', 'origin', 'https://gitlab.ugnas.com/group/project.git'], {
    windowsHide: true
  });
  const { stdout } = await execFileAsync('bash', [path.join(repoRoot, 'hooks/session-end.sh')], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });

  assert.match(stdout, /external-document-runtime-not-ready \(company\); documentation not persisted/u);
  assert.equal((await readdir(root)).includes('docs'), false);
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
