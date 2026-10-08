import test from 'node:test';
import assert from 'node:assert/strict';

import { routeRequestWithHps } from '../../lib/hps-legacy-route-bridge.mjs';

const input = (overrides = {}) => ({
  schema_version: 1,
  host: 'codex',
  cwd: '/project',
  message: '给这个功能写实施计划',
  active_route: null,
  ...overrides
});

const prepared = (overrides = {}) => ({
  routing: { route: 'planning', target_skill: 'horspowers:writing-plans', confidence: 1 },
  project: {
    eligibility: 'project',
    project_root: '/project',
    config_action: 'unchanged',
    docs_action: 'unchanged',
    ...overrides
  },
  scope: { scope_id: 'scope-1' }
});

test('unchanged HPS preparation returns the legacy envelope without invoking route apply', async () => {
  let legacyCalls = 0;
  const result = await routeRequestWithHps(input(), {
    prepare: async () => ({ prepared: prepared(), context: null }),
    planAgents: async () => ({ status: 'unchanged' }),
    legacy: async () => { legacyCalls += 1; return { should_not: 'run' }; }
  });
  assert.equal(legacyCalls, 0);
  assert.equal(result.project.config, 'unchanged');
  assert.equal(result.project.docs, 'unchanged');
  assert.equal(result.routing.target_skill, 'horspowers:writing-plans');
});

test('initialization actions use exactly one legacy apply fallback', async () => {
  let legacyCalls = 0;
  const result = await routeRequestWithHps(input(), {
    prepare: async () => ({ prepared: prepared({ config_action: 'create', docs_action: 'create' }), context: null }),
    planAgents: async () => ({ status: 'unchanged' }),
    legacy: async () => { legacyCalls += 1; return { fallback: true }; }
  });
  assert.equal(legacyCalls, 1);
  assert.deepEqual(result, { fallback: true });
});

test('unavailable HPS falls back once without guessing a project state', async () => {
  let legacyCalls = 0;
  const result = await routeRequestWithHps(input(), {
    prepare: async () => null,
    legacy: async () => { legacyCalls += 1; return { fallback: true }; }
  });
  assert.equal(legacyCalls, 1);
  assert.deepEqual(result, { fallback: true });
});

test('external HPS context never falls back to local initialization', async () => {
  let legacyCalls = 0;
  const result = await routeRequestWithHps(input({ message: '继续' }), {
    prepare: async () => ({
      prepared: prepared({ eligibility: 'external_project', config_action: 'external_required', docs_action: 'skipped' }),
      context: {
        status: 'ready',
        project: { identity_status: 'company', project_id: 'demo', project_fingerprint: 'company/demo' },
        config: { source: 'wiki' },
        documentation: { backend: 'wiki', auto_submit: false }
      }
    }),
    planAgents: async () => ({ status: 'skipped' }),
    legacy: async () => { legacyCalls += 1; return { fallback: true }; }
  });
  assert.equal(legacyCalls, 0);
  assert.equal(result.project.identity_status, 'company');
  assert.equal(result.project.documentation_backend, 'wiki');
});

test('steady-state bridge preserves the legacy stable envelope field-for-field', async () => {
  const result = await routeRequestWithHps(input(), {
    prepare: async () => ({
      prepared: {
        routing: {
          route: 'planning', target_skill: 'horspowers:writing-plans', confidence: 1,
          routing_rule_version: 3, matched_rules: ['plan'], candidates: ['planning'],
          context_policy: 'none'
        },
        project: {
          eligibility: 'project', config_action: 'valid', docs_action: 'skipped_disabled'
        },
        scope: { scope_id: 'scope-1' }
      },
      context: null
    }),
    planAgents: async () => ({ status: 'unchanged' }),
    legacy: async () => { throw new Error('legacy route must not run'); }
  });
  assert.deepEqual(result, {
    schema_version: 1,
    device: { agents_block: 'unchanged', router_version: 1 },
    project: {
      eligibility: 'project', config: 'unchanged', docs: 'skipped_disabled',
      identity_status: null, project_id: null, project_fingerprint: null,
      config_source: null, documentation_backend: null,
      documentation_status: null, auto_submit: false
    },
    routing: {
      route: 'planning', target_skill: 'horspowers:writing-plans', confidence: 1,
      routing_rule_version: 3, matched_rules: ['plan'], candidates: ['planning'],
      context_policy: 'none'
    },
    mutations: [
      { kind: 'agents_block', status: 'unchanged' },
      { kind: 'project_config', status: 'unchanged' },
      { kind: 'docs', status: 'skipped_disabled' }
    ]
  });
});
