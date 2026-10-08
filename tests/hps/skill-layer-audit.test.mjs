import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HPS_ERROR_CATALOG, HPS_OPERATION_DEFINITIONS, HPS_OPERATION_NAMES } from '../../lib/hps-operations.mjs';
import { DOCUMENT_RUNTIME_RESULT_STATUSES } from '../../lib/document-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillsRoot = path.join(repoRoot, 'skills');

/**
 * Layer audit across every skill.
 *
 * The skill layer breaks by drifting, not by crashing: a renamed file, an
 * invented operation, a status that no longer exists, a frontmatter name that
 * stopped matching its directory. Every one of those has been found by reading
 * rather than by a test, so the mechanical part is pinned here for all skills
 * instead of only for the entry skill.
 */

// Vocabulary a skill may use. Anything else that looks like an HPS identifier
// or a runtime status has to be listed here with a reason, so an invented name
// fails instead of quietly misleading an agent.
const NON_HPS_IDENTIFIERS = new Map([
  ['project_identity_unavailable', 'status emitted by lib/version-upgrade.js, not an HPS code']
]);
const IDENTIFIER_PREFIX = /^(document|project|context|verification|session|checkpoint|commit|merge|task|git|diff|runtime|submission|manifest|wiki|registry|local)_/u;
const DOCUMENT_ACTIONS = new Set([
  'resolve', 'get', 'search', 'create', 'update', 'archive', 'restore', 'config-change', 'record-session'
]);

// Two skills predate the repository's own 500-line guideline. The recorded
// size is their ceiling: they may not grow, and no other skill may cross it.
const OVERSIZED_SKILL_CEILING = new Map([
  ['automated-development-workflow', 746],
  ['writing-skills', 668]
]);
const SIZE_GUIDELINE = 500;

const stripFences = (text) => text.replace(/```[\s\S]*?```/gu, '');
const inline = (text) => [...stripFences(text).matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
const isPlaceholder = (token) => /[<>{}*$@]/u.test(token) || token.includes('YYYY') || token.includes('MM-DD')
  || token.startsWith('~') || token.startsWith('/') || token.includes('://');

function knownName(token) {
  return HPS_OPERATION_NAMES.includes(token)
    || Object.hasOwn(HPS_ERROR_CATALOG, token)
    || DOCUMENT_RUNTIME_RESULT_STATUSES.includes(token)
    || NON_HPS_IDENTIFIERS.has(token);
}

/** Paths a skill tells an agent to open, with the bases they may resolve against. */
function referencedPaths(skill, text) {
  const body = stripFences(text);
  const tokens = new Set();
  for (const match of body.matchAll(/\]\(([^)\s]+)\)/gu)) tokens.add(match[1]);
  for (const token of inline(text)) {
    if (token.includes('/') && /\.(md|mjs|js|cjs|json|sh|ts|dot|ya?ml)$/u.test(token)) tokens.add(token);
  }
  return [...tokens].map((token) => token.split('#')[0]).filter((token) => token.length > 0 && !isPlaceholder(token))
    .map((token) => (token.startsWith('horspowers:')
      ? path.join(skillsRoot, token.slice('horspowers:'.length))
      : [path.resolve(skillsRoot, skill, token), path.resolve(repoRoot, token)]));
}

/**
 * Pure checker so its own behaviour can be exercised with synthetic input.
 * @param {{skill: string, text: string, knownSkills: Set<string>, pathExists?: (candidates: string[]) => Promise<boolean>}} input
 * @returns {Promise<string[]>} human-readable findings
 */
export async function skillFindings({ skill, text, knownSkills, pathExists = null }) {
  const findings = [];

  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (!frontmatter) findings.push('no YAML frontmatter block');
  else {
    const name = /^name:\s*(.+)$/mu.exec(frontmatter[1])?.[1]?.trim();
    const description = /^description:\s*(.+)$/mu.exec(frontmatter[1])?.[1]?.trim() ?? '';
    if (!name) findings.push('frontmatter has no name');
    else if (name !== skill) findings.push(`frontmatter name "${name}" != directory "${skill}"`);
    if (!description) findings.push('frontmatter has no description');
    else if (description.length > 1024) findings.push(`description is ${description.length} characters, over the 1024 limit`);
  }

  for (const match of stripFences(text).matchAll(/horspowers:([a-z0-9-]+)/gu)) {
    if (!knownSkills.has(match[1])) findings.push(`horspowers:${match[1]} is not a skill`);
  }

  if (typeof pathExists === 'function') {
    for (const candidates of referencedPaths(skill, text)) {
      if (!(await pathExists(candidates))) {
        findings.push(`references a path that does not exist: ${candidates.map((entry) => path.relative(repoRoot, entry)).join(' | ')}`);
      }
    }
  }

  for (const token of inline(text)) {
    if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(token) && IDENTIFIER_PREFIX.test(token) && !knownName(token)) {
      findings.push(`names an unknown identifier: ${token}`);
    }
  }
  // Call literals live inside fenced examples, so scan the raw text: a bad
  // call shown in an example is exactly the defect this catches.
  for (const match of text.matchAll(/"operation":\s*"([a-z_]+)"/gu)) {
    const operation = match[1];
    if (!HPS_OPERATION_NAMES.includes(operation)) findings.push(`calls an unknown operation: ${operation}`);
    else if (HPS_OPERATION_DEFINITIONS[operation].deferred) findings.push(`calls a deferred operation through HPS: ${operation}`);
  }
  for (const match of text.matchAll(/"action":\s*"([a-z-]+)"/gu)) {
    if (!DOCUMENT_ACTIONS.has(match[1])) findings.push(`names an unknown document action: ${match[1]}`);
  }
  return findings;
}

async function skillNames() {
  return (await readdir(skillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function pathExists(candidates) {
  for (const candidate of candidates) {
    try { await stat(candidate); return true; } catch { /* try the next base */ }
  }
  return false;
}

test('every skill passes the layer audit', async () => {
  const names = await skillNames();
  assert.ok(names.length >= 19, `expected the full skill set, found ${names.length}`);
  const knownSkills = new Set(names);
  const failures = [];
  for (const skill of names) {
    const text = await readFile(path.join(skillsRoot, skill, 'SKILL.md'), 'utf8');
    for (const finding of await skillFindings({ skill, text, knownSkills, pathExists })) {
      failures.push(`${skill}: ${finding}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('no skill exceeds the recorded size ceiling', async () => {
  const failures = [];
  for (const skill of await skillNames()) {
    const text = await readFile(path.join(skillsRoot, skill, 'SKILL.md'), 'utf8');
    const lines = text.split('\n').length;
    const ceiling = OVERSIZED_SKILL_CEILING.get(skill) ?? SIZE_GUIDELINE;
    if (lines > ceiling) failures.push(`${skill}: ${lines} lines > ceiling ${ceiling}`);
  }
  assert.deepEqual(failures, []);
});

test('the layer audit rejects each kind of drift it exists for', async () => {
  const knownSkills = new Set(['brainstorming']);
  const base = [
    '---', 'name: brainstorming', 'description: Use when testing the audit.', '---', '',
    '见 `references/exists.md`。', '使用 `task_prepare`。', '```json', '{"operation": "task_prepare"}', '```'
  ].join('\n');
  const exists = async () => true;
  const missing = async () => false;

  assert.deepEqual(await skillFindings({ skill: 'brainstorming', text: base, knownSkills, pathExists: exists }), []);

  const missingFindings = await skillFindings({ skill: 'brainstorming', text: base, knownSkills, pathExists: missing });
  assert.equal(missingFindings.length, 1);
  assert.match(missingFindings[0], /does not exist: skills\/brainstorming\/references\/exists\.md/u);

  assert.ok((await skillFindings({
    skill: 'brainstorming', text: base.replace('name: brainstorming', 'name: other'), knownSkills, pathExists: exists
  })).some((finding) => finding.includes('!= directory')));

  assert.ok((await skillFindings({
    skill: 'brainstorming', text: `${base}\n见 \`horspowers:absent-skill\`。`, knownSkills, pathExists: exists
  })).some((finding) => finding.includes('is not a skill')));

  assert.ok((await skillFindings({
    skill: 'brainstorming', text: `${base}\n使用 \`document_teleport\`。`, knownSkills, pathExists: exists
  })).some((finding) => finding.includes('unknown identifier')));

  assert.ok((await skillFindings({
    skill: 'brainstorming', text: base.replace('{"operation": "task_prepare"}', '{"operation": "document_change_submit"}'),
    knownSkills, pathExists: exists
  })).some((finding) => finding.includes('deferred operation')));

  assert.ok((await skillFindings({
    skill: 'brainstorming', text: `${base}\n\`\`\`json\n{"action": "delete"}\n\`\`\``, knownSkills, pathExists: exists
  })).some((finding) => finding.includes('unknown document action')));
});
