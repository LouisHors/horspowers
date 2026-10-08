import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HPS_OPERATION_DEFINITIONS, exposedHpsTools } from '../../lib/hps-operations.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillPath = path.join(repoRoot, 'skills/using-horspowers/SKILL.md');
const hpsBin = path.join(repoRoot, 'bin', 'hps');

// The skill text and the runtime have drifted twice already: `scope_id` was
// presented as reusable across `hps call` processes, and `mutations` was
// presented as a `task_prepare` field. Both were caught by reading, not by a
// test. This suite derives the expected shape from the operation registry and
// from a real CLI envelope so the text cannot drift again.

function backticked(text) {
  return [...text.matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
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
 * @returns {string[]}
 */
export function validateSkillContract(skillText) {
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
  return violations;
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

test('the contract checker rejects both kinds of drift', () => {
  const registry = operationListsFromRegistry();
  const render = (free, scoped, extra = '') => [
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
