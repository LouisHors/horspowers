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

test('blocks company target skills until the external document runtime is ready', async () => {
  const result = await routeRequest(input('给这个功能写实施计划'), {
    loadRules: async () => rules,
    planAgents: async () => ({ status: 'unchanged' }),
    planProject: async () => ({
      eligibility: 'external_project',
      project_root: '/retained-fixture/company-project',
      config_action: 'external_required',
      docs_action: 'skipped',
      reason: 'company_external_config_required'
    }),
    applyAgents: async () => ({ status: 'unchanged' }),
    applyProject: async () => ({ config: { status: 'external_required' }, docs: { status: 'skipped' } })
  });

  assert.equal(result.routing.route, 'planning');
  assert.equal(result.routing.target_skill, null);
  assert.equal(result.routing.blocked_by, 'company_external_config_required');
  assert.equal(result.project.eligibility, 'external_project');
  assert.equal(result.project.config, 'external_required');
  assert.equal(result.project.docs, 'skipped');
});

test('adds resolved external Wiki context without releasing the Task 1 safety gate', async () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`;
  const result = await routeRequest(input('给这个功能写实施计划'), {
    loadRules: async () => rules,
    planAgents: async () => ({ status: 'unchanged' }),
    planProject: async () => ({
      eligibility: 'external_project',
      project_root: '/retained-fixture/company-project',
      identity: {
        kind: 'company',
        project_fingerprint: fingerprint
      },
      config_action: 'external_required',
      docs_action: 'skipped',
      reason: 'company_external_config_required'
    }),
    resolveProjectContext: async () => ({
      status: 'ready',
      project: {
        identity_status: 'company',
        project_id: 'ugnas/ugcli-lib',
        project_fingerprint: fingerprint
      },
      config: { source: 'wiki', value: {} },
      documentation: { backend: 'wiki', enabled: true, auto_submit: true }
    }),
    applyAgents: async () => ({ status: 'unchanged' }),
    applyProject: async () => ({ config: { status: 'external_required' }, docs: { status: 'skipped' } })
  });

  assert.equal(result.routing.route, 'planning');
  assert.equal(result.routing.target_skill, null);
  assert.equal(result.routing.blocked_by, 'company_external_config_required');
  assert.equal(result.project.identity_status, 'company');
  assert.equal(result.project.project_id, 'ugnas/ugcli-lib');
  assert.equal(result.project.project_fingerprint, fingerprint);
  assert.equal(result.project.config_source, 'wiki');
  assert.equal(result.project.documentation_backend, 'wiki');
  assert.equal(result.project.auto_submit, true);
  assert.equal(result.project.config, 'external_required');
  assert.equal(result.project.docs, 'skipped');
});

test('keeps the classified intent and skips local mutations when external context throws', async () => {
  let applyProjectCalls = 0;
  const result = await routeRequest(input('给这个功能写实施计划'), {
    loadRules: async () => rules,
    planAgents: async () => ({ status: 'unchanged' }),
    planProject: async () => ({
      eligibility: 'external_project',
      project_root: '/retained-fixture/company-project',
      identity: { kind: 'company', project_fingerprint: `sha256:${'a'.repeat(64)}` },
      config_action: 'external_required',
      docs_action: 'skipped',
      reason: 'company_external_config_required'
    }),
    resolveProjectContext: async () => { throw new Error('synthetic context failure'); },
    applyAgents: async () => ({ status: 'unchanged' }),
    applyProject: async (plan) => {
      applyProjectCalls += 1;
      assert.equal(plan.eligibility, 'external_project');
      return { config: { status: 'external_required' }, docs: { status: 'skipped' } };
    }
  });

  assert.equal(result.routing.route, 'planning');
  assert.equal(result.routing.target_skill, null);
  assert.equal(result.project.config_source, 'none');
  assert.equal(result.project.documentation_backend, 'disabled');
  assert.equal(result.project.auto_submit, false);
  assert.equal(applyProjectCalls, 1);
});

test('keeps target skill routing for ordinary projects', async () => {
  const result = await routeRequest(input('给这个功能写实施计划'), {
    loadRules: async () => rules,
    planAgents: async () => ({ status: 'unchanged' }),
    planProject: async () => ({
      eligibility: 'project',
      project_root: '/retained-fixture/ordinary-project',
      config_action: 'unchanged',
      docs_action: 'unchanged',
      reason: null
    }),
    applyAgents: async () => ({ status: 'unchanged' }),
    applyProject: async () => ({ config: { status: 'unchanged' }, docs: { status: 'unchanged' } })
  });

  assert.equal(result.routing.route, 'planning');
  assert.equal(result.routing.target_skill, 'horspowers:writing-plans');
  assert.equal(result.routing.blocked_by, undefined);
});

test('only restores company target skills when a future runtime capability is injected', async () => {
  const result = await routeRequest(input('给这个功能写实施计划'), {
    externalDocumentRuntimeVersion: 1,
    loadRules: async () => rules,
    planAgents: async () => ({ status: 'unchanged' }),
    planProject: async () => ({
      eligibility: 'external_project',
      project_root: '/retained-fixture/company-project',
      config_action: 'external_required',
      docs_action: 'skipped',
      reason: 'company_external_config_required'
    }),
    applyAgents: async () => ({ status: 'unchanged' }),
    applyProject: async () => ({ config: { status: 'external_required' }, docs: { status: 'skipped' } })
  });

  assert.equal(result.routing.route, 'planning');
  assert.equal(result.routing.target_skill, 'horspowers:writing-plans');
  assert.equal(result.routing.blocked_by, undefined);
});
