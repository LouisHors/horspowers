import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HPS_OPERATION_DEFINITIONS, exposedHpsTools } from '../../lib/hps-operations.mjs';
import { parseCallRequest } from '../../lib/hps-protocol.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillDir = path.join(repoRoot, 'skills/using-horspowers');
const skillPath = path.join(skillDir, 'SKILL.md');
const pathReferencePath = path.join(skillDir, 'references/host-path-resolution.md');
const hpsBin = path.join(repoRoot, 'bin', 'hps');

// The skill text and the runtime have drifted twice already: `scope_id` was
// presented as reusable across `hps call` processes, and `mutations` was
// presented as a `task_prepare` field. Both were caught by reading, not by a
// test. This suite derives the expected shape from the operation registry and
// from a real CLI envelope so the text cannot drift again.

function backticked(text) {
  return [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
}

/** Every fenced ```json block that parses as JSON. */
function jsonBlocks(markdown) {
  const blocks = [];
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/gu)) {
    try { blocks.push(JSON.parse(match[1])); } catch { /* illustrative, not JSON */ }
  }
  return blocks;
}

function isCallRequest(value) {
  try { parseCallRequest(value); return true; } catch { return false; }
}

/**
 * Inline `code` tokens, ignoring fenced blocks. A fenced block's run of three
 * backticks would otherwise pair with the wrong delimiters and swallow the
 * whole block as one token.
 */
function inlineCode(markdown) {
  const withoutFences = markdown.replace(/```[\s\S]*?```/gu, '');
  return [...withoutFences.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
}

/**
 * Paths the skill tells an agent to open: `references/*.md` relative to the
 * skill directory, and bare script basenames such as `collect-context.mjs`.
 */
function referencedSkillPaths(skillText) {
  const references = new Set();
  for (const token of inlineCode(skillText)) {
    if (/^references\/[A-Za-z0-9._-]+\.md$/u.test(token)) references.add(token);
    else if (/^[a-z0-9_-]+\.mjs$/u.test(token)) references.add(token);
  }
  return [...references].sort();
}

function expandGlob(name) {
  if (!name.endsWith('*')) return [name];
  const prefix = name.slice(0, -1);
  return Object.keys(HPS_OPERATION_DEFINITIONS).filter((operation) => operation.startsWith(prefix));
}

/** The scope-free and scope-required lists the skill writes down. */
function operationListsFromSkill(skillText) {
  const lines = skillText.split('\n');
  const freeLine = lines.find((line) => line.includes('无 MCP 时可以直接一次性调用'));
  const scopedLine = lines.find((line) => line.includes('必需 `scope_id` 的 operation 不能跨'));
  if (!freeLine || !scopedLine) return null;
  const ignored = new Set(['scope_id', 'hps call']);
  // Each list ends at the first full stop; the same line then names the
  // compatibility entries, which are not operations.
  const collect = (line) => backticked(line.split('。')[0])
    .filter((token) => !ignored.has(token))
    .flatMap(expandGlob)
    .sort();
  return { free: collect(freeLine), scoped: collect(scopedLine) };
}

/** The same two lists as the runtime actually defines them. */
function operationListsFromRegistry() {
  const exposed = exposedHpsTools().map((tool) => tool.name);
  const needsScope = (name) => HPS_OPERATION_DEFINITIONS[name].required.includes('scope_id');
  return { free: exposed.filter((name) => !needsScope(name)).sort(), scoped: exposed.filter(needsScope).sort() };
}

/**
 * Return human-readable contract violations instead of throwing, so the
 * checker itself can be exercised against the wording that shipped before.
 * @param {string} skillText
 * @param {{fileExists?: (reference: string) => boolean}} [options]
 * @returns {string[]}
 */
export function validateSkillContract(skillText, { fileExists = null } = {}) {
  const violations = [];
  const fromSkill = operationListsFromSkill(skillText);
  const fromRegistry = operationListsFromRegistry();
  if (!fromSkill) {
    violations.push('skill must keep the two operation lists under "## 执行通道"');
    return violations;
  }
  if (fromSkill.free.join() !== fromRegistry.free.join()) {
    violations.push(`scope-free list drifted: skill=[${fromSkill.free.join(', ')}] registry=[${fromRegistry.free.join(', ')}]`);
  }
  if (fromSkill.scoped.join() !== fromRegistry.scoped.join()) {
    violations.push(`scope-required list drifted: skill=[${fromSkill.scoped.join(', ')}] registry=[${fromRegistry.scoped.join(', ')}]`);
  }
  if (/`mutations`\s*只报告/u.test(skillText)) {
    violations.push('mutations is described as a task_prepare field, but the primary envelope never returns it');
  }
  if (!skillText.includes('`project.config_action`') || !skillText.includes('`project.docs_action`')) {
    violations.push('skill must name project.config_action and project.docs_action as the primary change state');
  }
  // The flat {schema_version, host, cwd, message, active_route} object is the
  // legacy route-request.mjs input. `hps call` requires the canonical envelope,
  // so the skill must ship an example the CLI actually accepts; otherwise an
  // agent following it gets `invalid_request` and silently falls back.
  if (!jsonBlocks(skillText).some(isCallRequest)) {
    violations.push('skill must show a `hps call` request the CLI accepts: schema_version, request_id, operation, cwd, input');
  }
  // A renamed or deleted file leaves the skill pointing at nothing.
  if (typeof fileExists === 'function') {
    for (const reference of referencedSkillPaths(skillText)) {
      if (!fileExists(reference)) violations.push(`skill references a path that does not exist: ${reference}`);
    }
  }
  return violations;
}

/**
 * Two documents that describe the same channel must agree. Sharing one
 * variable name across two different payload shapes is what made the flat
 * object look like an `hps call` payload, so the names are part of the
 * contract, not cosmetics.
 * @param {string} skillText
 * @param {string} pathReferenceText
 * @returns {string[]}
 */
export function validateChannelDocs(skillText, pathReferenceText) {
  const violations = [];
  for (const [name, text] of [['SKILL.md', skillText], ['host-path-resolution.md', pathReferenceText]]) {
    if (!text.includes('HPS_CALL_REQUEST')) {
      violations.push(`${name} must name the call envelope variable HPS_CALL_REQUEST`);
    }
    if (/\bHPS_REQUEST\b/u.test(text)) {
      violations.push(`${name} must not use the ambiguous HPS_REQUEST alongside HPS_CALL_REQUEST`);
    }
  }
  if (!/`invalid_request`[\s\S]{0,200}不得[\s\S]{0,80}降级/u.test(skillText)) {
    violations.push('skill must state that invalid_request is a caller shape error and must not trigger the fallback');
  }
  if (!/operation_unavailable|operation_not_found/u.test(skillText)) {
    violations.push('skill must classify non-availability codes instead of treating any non-zero result as HPS unavailable');
  }
  return violations;
}

/** Basenames of every .mjs file under the given roots, for bare script references. */
async function indexScriptBasenames(roots) {
  const index = new Set();
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith('.mjs')) index.add(entry.name);
    }
  };
  for (const root of roots) await walk(root);
  return index;
}

function runHpsCall(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hpsBin, 'call'], {
      cwd: repoRoot, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(request);
  });
}

function envelopeFrom(stdout) {
  const envelopes = stdout.split('\n').filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value?.schema_version === 1 && typeof value?.status === 'string' ? [value] : [];
    } catch { return []; }
  });
  return envelopes.at(-1) ?? null;
}

test('the skill operation lists match the HPS operation registry', async () => {
  const skillText = await readFile(skillPath, 'utf8');
  assert.deepEqual(validateSkillContract(skillText), []);
});

test('the skill only points at references and scripts that exist', async () => {
  const skillText = await readFile(skillPath, 'utf8');
  const scripts = await indexScriptBasenames([path.join(repoRoot, 'lib'), path.join(repoRoot, 'skills')]);
  const fileExists = (reference) => (reference.startsWith('references/')
    ? existsSync(path.join(skillDir, reference))
    : scripts.has(reference));

  const references = referencedSkillPaths(skillText);
  assert.ok(references.length >= 3, `expected the skill to reference its files, found ${JSON.stringify(references)}`);
  assert.deepEqual(validateSkillContract(skillText, { fileExists }), []);
});

test('the two channel documents agree on payload names and error classes', async () => {
  const skillText = await readFile(skillPath, 'utf8');
  const pathReferenceText = await readFile(pathReferencePath, 'utf8');
  assert.deepEqual(validateChannelDocs(skillText, pathReferenceText), []);
});

test('the contract checker rejects both kinds of drift', async () => {
  const registry = operationListsFromRegistry();
  const render = (free, scoped, extra = '') => [
    '## 安全输入契约',
    '```json',
    JSON.stringify({
      schema_version: 1,
      request_id: 'route-1',
      operation: 'task_prepare',
      cwd: '/absolute/project/path',
      input: { host: 'pi', message: '先写失败测试', active_route: null }
    }, null, 2),
    '```',
    '## 执行通道',
    `- **无 MCP 时可以直接一次性调用**：${free.map((name) => `\`${name}\``).join('、')}。`,
    `- **必需 \`scope_id\` 的 operation 不能跨 \`hps call\` 进程调用**：${scoped.map((name) => `\`${name}\``).join('、')}。`,
    '变更状态读 `project.config_action` 与 `project.docs_action`。',
    extra
  ].join('\n');

  // A correct document passes, so the checker is not simply always failing.
  assert.deepEqual(validateSkillContract(render(registry.free, registry.scoped)), []);

  // The wording that shipped: mutations claimed as a task_prepare field.
  const mutationsDrift = render(registry.free, registry.scoped,
    '`mutations` 只报告 AGENTS 托管区块、项目配置和通用 docs 的状态。');
  assert.ok(
    validateSkillContract(mutationsDrift).some((violation) => violation.includes('mutations')),
    'checker must flag the historical mutations wording'
  );

  // A list that gains an operation the registry does not expose.
  const listDrift = render([...registry.free, 'verify_everything'].sort(), registry.scoped);
  assert.ok(validateSkillContract(listDrift).some((violation) => violation.includes('scope-free list drifted')));

  // The request example must be one the CLI accepts.
  const flatOnly = render(registry.free, registry.scoped).replace(
    /"operation": "task_prepare",\n  "cwd"/u,
    '"host": "pi",\n  "cwd"'
  );
  assert.notEqual(flatOnly, render(registry.free, registry.scoped));
  assert.ok(
    validateSkillContract(flatOnly).some((violation) => violation.includes('`hps call` request')),
    'checker must reject a flat route-request payload presented as an hps call request'
  );

  // A reference to a file that does not exist.
  const staleReference = `${render(registry.free, registry.scoped)}\n见 \`references/does-not-exist.md\`。\n`;
  assert.ok(
    validateSkillContract(staleReference, { fileExists: () => false })
      .some((violation) => violation.includes('does not exist')),
    'checker must reject a reference to a missing file'
  );
  assert.deepEqual(validateSkillContract(staleReference, { fileExists: () => true }), []);

  // A non-zero result must not be flattened into "HPS unavailable", and the
  // two documents must not disagree about the payload variable.
  const channelSkill = await readFile(skillPath, 'utf8');
  const channelReference = await readFile(pathReferencePath, 'utf8');
  assert.ok(
    validateChannelDocs(channelSkill.replace(/HPS_CALL_REQUEST/gu, 'HPS_REQUEST'), channelReference)
      .some((violation) => violation.includes('ambiguous HPS_REQUEST')),
    'checker must reject the ambiguous variable name'
  );
  assert.ok(
    validateChannelDocs(channelSkill, channelReference.replace(/HPS_CALL_REQUEST/gu, 'HPS_PAYLOAD'))
      .some((violation) => violation.includes('HPS_CALL_REQUEST')),
    'checker must reject a document that names the envelope differently'
  );
  assert.ok(
    validateChannelDocs(channelSkill.replace(/`invalid_request`[\s\S]{0,200}不得[\s\S]{0,80}降级/gu, ''), channelReference)
      .some((violation) => violation.includes('caller shape error')),
    'checker must require the invalid_request prohibition'
  );

  // The lists must survive; dropping them is not a way to pass.
  assert.deepEqual(validateSkillContract('## 执行通道\n无列表\n'), [
    'skill must keep the two operation lists under "## 执行通道"'
  ]);
});

test('task_prepare returns the fields the skill names and never returns mutations', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'hps-skill-contract-'));
  try {
    const result = await runHpsCall(JSON.stringify({
      schema_version: 1,
      request_id: 'skill-contract',
      operation: 'task_prepare',
      cwd,
      input: { message: '先写失败测试', host: 'pi' }
    }));
    const envelope = envelopeFrom(result.stdout);
    assert.ok(envelope, `hps call must emit an envelope; stderr=${result.stderr.slice(0, 400)}`);
    assert.equal(envelope.status, 'ok');
    for (const field of ['routing', 'project', 'collected', 'scope', 'capabilities']) {
      assert.ok(
        Object.hasOwn(envelope.result, field),
        `the skill names ${field} as a task_prepare result field, but the envelope does not contain it`
      );
    }
    assert.equal(
      Object.hasOwn(envelope.result, 'mutations'),
      false,
      'the skill must not send agents looking for mutations; the primary envelope does not return it'
    );
    assert.equal(envelope.result.project.config_action !== undefined, true);
    assert.equal(envelope.result.project.docs_action !== undefined, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the skill handles the fail-closed project class instead of a legacy gate field', async () => {
  const skillText = await readFile(skillPath, 'utf8');

  // `blocked_by` has exactly one producer and it only runs for a caller that
  // declares an older external-document-runtime version; current callers pass
  // the current one, so the field never appears. The live signal for a project
  // that must not receive local config or docs is the project class.
  const gateProducer = await readFile(path.join(repoRoot, 'lib/workflow-router.mjs'), 'utf8');
  assert.match(gateProducer, /externalDocumentRuntimeVersion >= 1/u, 'the gate must stay a below-v1 compatibility path');
  const runtimeVersion = await readFile(path.join(repoRoot, 'lib/document-runtime-capabilities.mjs'), 'utf8');
  const declared = Number(/EXTERNAL_DOCUMENT_RUNTIME_VERSION = (\d+)/u.exec(runtimeVersion)?.[1]);
  assert.ok(declared >= 1, `the current external runtime version must be at least 1, got ${declared}`);

  assert.match(skillText, /`external_required`/u, 'the skill must name the live fail-closed signal');
  assert.match(skillText, /`external_project`/u, 'the skill must name the project class that fails closed');
  assert.match(skillText, /`blocked_by`[^。\n]*兼容/u, 'blocked_by must be described as a compatibility field');
});
