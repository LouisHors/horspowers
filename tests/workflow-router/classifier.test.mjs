import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { loadAndValidateRules } from '../../lib/route-rules.mjs';
import { classifyRequest } from '../../lib/workflow-router.mjs';

let rules;

before(async () => {
  rules = await loadAndValidateRules();
});

const cases = [
  ['uses an explicit skill request', '使用 horspowers:writing-plans', null, 'planning', 'horspowers:writing-plans'],
  ['plans an approved solution', '方案已经批准，拆成实施步骤', null, 'planning', 'horspowers:writing-plans'],
  ['debugs before proposing a fix', '这个 bug 出现异常，先定位根因并缩小范围', null, 'debugging', 'horspowers:systematic-debugging'],
  ['uses TDD for a bug fix', '先写失败测试再修 bug', null, 'tdd', 'horspowers:test-driven-development'],
  ['executes a plan with checkpoints', '已有计划，分批执行，每批停下来汇报', null, 'checkpoint_execution', 'horspowers:executing-plans'],
  ['executes independent plan tasks continuously', '已有计划和独立任务列表，连续推进，不用等我', null, 'continuous_execution', 'horspowers:subagent-driven-development'],
  ['routes a self-contained translation directly', '把这段文字翻译成英文', null, 'direct', null],
  ['keeps an unscoped continuation uncertain', '继续', null, 'uncertain', null],
  ['uses a valid active route for a continuation', '继续', 'planning', 'planning', 'horspowers:writing-plans'],
  ['lets a current checkpoint request replace the active route', '继续按计划分批做', 'planning', 'checkpoint_execution', 'horspowers:executing-plans'],
  ['lets a current TDD request replace the active route', '改成先写失败测试', 'debugging', 'tdd', 'horspowers:test-driven-development'],
  ['keeps simultaneous debugging and TDD instructions uncertain', '这个 bug 先定位根因，也先写失败测试', null, 'uncertain', null]
];

for (const [name, message, activeRoute, route, targetSkill] of cases) {
  test(name, () => {
    const result = classifyRequest({ message, active_route: activeRoute }, rules);

    assert.equal(result.route, route);
    assert.equal(result.target_skill, targetSkill);
    if (targetSkill === null) {
      assert.equal(result.target_skill, null);
    } else {
      assert.equal(result.candidates.filter((candidate) => candidate === route).length, 1);
    }
  });
}
