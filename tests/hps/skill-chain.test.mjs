import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');

async function skill(name) {
  return readFile(path.join(root, 'skills', name, 'SKILL.md'), 'utf8');
}

test('default workflow skills use HPS for deterministic boundaries and retain safe legacy fallback', async () => {
  const using = await skill('using-horspowers');
  const brainstorm = await skill('brainstorming');
  const documents = await skill('document-management');

  assert.match(using, /hps serve --stdio/u);
  assert.match(using, /hps call/u);
  assert.match(using, /legacy `route-request\.mjs`/u);
  assert.match(using, /config_action.*docs_action[\s\S]*steady-state `unchanged`/u);
  assert.match(brainstorm, /task_prepare/u);
  assert.match(brainstorm, /不要在同一请求中同时执行 HPS 与旧 collector/u);
  assert.match(documents, /HPS `task_prepare`/u);
  assert.match(documents, /同一 `scope_id`/u);
  assert.match(documents, /不跨进程复用 scope/u);
});

