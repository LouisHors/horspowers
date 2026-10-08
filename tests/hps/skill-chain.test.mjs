import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');

async function skill(name) {
  return readFile(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
}

test('using-horspowers separates the task_prepare envelope from the legacy router envelope', async () => {
  const using = await skill('using-horspowers');

  // `mutations` belongs to the legacy route-request envelope. `task_prepare`
  // reports config/docs state through `project`, so describing `mutations` as a
  // field of the primary path sends an agent looking for something that is
  // never returned.
  assert.match(using, /`project\.config_action`/u);
  assert.match(using, /`project\.docs_action`/u);
  assert.match(using, /`mutations` 不是 `task_prepare` 的字段[^。]*legacy/u);
  assert.doesNotMatch(using, /`mutations` 只报告/u);

  // The stdin contract is host-specific; a fixed `codex` example misleads a
  // host that must send `claude` or `pi`.
  assert.match(using, /`host`[^。\n]*`codex`[^。\n]*`claude`[^。\n]*`pi`/u);
});

test('default workflow skills use HPS for deterministic boundaries and retain safe legacy fallback', async () => {
  const using = await skill('using-horspowers');
  const brainstorm = await skill('brainstorming');
  const documents = await skill('document-management');

  assert.match(using, /hps serve --stdio/u);
  assert.match(using, /hps call/u);
  assert.match(using, /legacy `route-request\.mjs`/u);
  assert.match(using, /config_action.*docs_action[\s\S]*steady-state `unchanged`/u);
  assert.match(using, /## 执行通道/u);
  assert.match(using, /必需 `scope_id`/u);
  assert.match(using, /document-runtime-cli\.mjs/u);
  assert.match(brainstorm, /task_prepare/u);
  assert.match(brainstorm, /不要在同一请求中同时执行 HPS 与旧 collector/u);
  assert.match(documents, /同一 `scope_id`/u);
  assert.match(documents, /不跨进程复用 scope/u);
  assert.match(documents, /必需 `scope_id`/u);
  assert.match(documents, /document-runtime-cli\.mjs/u);
  // A CLI process cannot carry a scope, so no skill may present it as a path.
  assert.doesNotMatch(documents, /先 `task_prepare` 取 scope/u);
});


test('every host that runs a delegated prompt has a tool mapping', async () => {
  const using = await skill('using-horspowers');
  const piMapping = await readFile(path.join(root, 'skills/using-horspowers/references/pi-tools.md'), 'utf8')
    .catch(() => null);
  assert.ok(piMapping, 'Pi needs a tool-name mapping alongside codex-tools.md');
  assert.match(piMapping, /`subagent`/u, 'Pi dispatches subagents with `subagent`');
  assert.match(piMapping, /`todo`/u, 'Pi tracks checklists with `todo`');
  assert.match(using, /references\/pi-tools\.md/u, 'using-horspowers must point at the Pi mapping');

  // A prompt handed to a subagent must name the host equivalents itself: the
  // subagent has the prompt, not necessarily the entry skill.
  for (const prompt of [
    'skills/brainstorming/spec-document-reviewer-prompt.md',
    'skills/subagent-driven-development/implementer-prompt.md',
    'skills/subagent-driven-development/spec-reviewer-prompt.md',
    'skills/subagent-driven-development/code-quality-reviewer-prompt.md',
    'skills/writing-plans/plan-document-reviewer-prompt.md'
  ]) {
    const text = await readFile(path.join(root, prompt), 'utf8');
    assert.doesNotMatch(text, /\bTask tool\b/u, `${prompt} must not name only the Claude tool`);
    assert.match(text, /`subagent`/u, `${prompt} must name the Pi equivalent`);
  }
});

test('the workflow wires isolation and completion verification', async () => {
  const execution = await skill('executing-plans');
  const subagents = await skill('subagent-driven-development');
  const tdd = await skill('test-driven-development');
  const finishing = await skill('finishing-a-development-branch');

  // Both execution entries assume an isolated workspace but used to leave the
  // isolation skill unreachable.
  assert.match(execution, /horspowers:using-git-worktrees/u);
  assert.match(subagents, /horspowers:using-git-worktrees/u);
  // The completion gate applies before claiming done or integrating.
  assert.match(tdd, /horspowers:verification-before-completion/u);
  assert.match(finishing, /horspowers:verification-before-completion/u);
});
