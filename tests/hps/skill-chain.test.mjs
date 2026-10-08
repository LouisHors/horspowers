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

