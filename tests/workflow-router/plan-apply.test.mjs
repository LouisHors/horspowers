import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { loadAndValidateRules } from '../../lib/route-rules.mjs';
import { routeRequest } from '../../lib/workflow-router.mjs';

let rules;

before(async () => {
  rules = await loadAndValidateRules();
});

function input(message = '把这段文字翻译成英文') {
  return {
    schema_version: 1,
    host: 'codex',
    cwd: '/retained-fixture/project',
    message,
    active_route: null
  };
}

test('returns uncertain without mutations when rule loading fails before any plan', async () => {
  let planCalls = 0;
  let applyCalls = 0;
  const result = await routeRequest(input(), {
    loadRules: async () => { throw new Error('invalid rules'); },
    planAgents: async () => { planCalls += 1; },
    planProject: async () => { planCalls += 1; },
    applyAgents: async () => { applyCalls += 1; },
    applyProject: async () => { applyCalls += 1; }
  });

  assert.equal(result.routing.route, 'uncertain');
  assert.equal(result.routing.routing_error, 'RULES_INVALID');
  assert.deepEqual(result.mutations, []);
  assert.equal(planCalls, 0);
  assert.equal(applyCalls, 0);
});

test('returns PLAN_FAILED without mutations when any read-only plan fails', async () => {
  let applyCalls = 0;
  const result = await routeRequest(input(), {
    loadRules: async () => rules,
    planAgents: async () => ({ status: 'failed', error: 'duplicate markers' }),
    planProject: async () => ({ eligibility: 'project', config_action: 'create', docs_action: 'create' }),
    applyAgents: async () => { applyCalls += 1; },
    applyProject: async () => { applyCalls += 1; }
  });

  assert.equal(result.routing.route, 'uncertain');
  assert.equal(result.routing.routing_error, 'PLAN_FAILED');
  assert.deepEqual(result.mutations, []);
  assert.equal(applyCalls, 0);
});

test('retains earlier Apply results and resumes only the unfinished docs step', async () => {
  let attempt = 0;
  const mutations = [];
  const dependencies = {
    loadRules: async () => rules,
    planAgents: async () => ({ status: attempt === 0 ? 'create' : 'unchanged' }),
    planProject: async () => ({
      eligibility: 'project',
      config_action: attempt === 0 ? 'create' : 'unchanged',
      docs_action: attempt === 0 ? 'create' : 'repair_missing_structure'
    }),
    applyAgents: async (plan) => {
      mutations.push(`agents:${plan.status}`);
      return { status: attempt === 0 ? 'created' : 'unchanged' };
    },
    applyProject: async () => {
      mutations.push(`project:${attempt}`);
      return attempt === 0
        ? { config: { status: 'created' }, docs: { status: 'failed', error: 'injected docs failure' } }
        : { config: { status: 'unchanged' }, docs: { status: 'created' } };
    }
  };

  const first = await routeRequest(input(), dependencies);
  attempt += 1;
  const second = await routeRequest(input(), dependencies);

  assert.equal(first.routing.route, 'direct');
  assert.equal(first.device.agents_block, 'created');
  assert.equal(first.project.config, 'created');
  assert.equal(first.project.docs, 'failed');
  assert.equal(second.routing.route, 'direct');
  assert.equal(second.device.agents_block, 'unchanged');
  assert.equal(second.project.config, 'unchanged');
  assert.equal(second.project.docs, 'created');
  assert.deepEqual(mutations, ['agents:create', 'project:0', 'agents:unchanged', 'project:1']);
});
