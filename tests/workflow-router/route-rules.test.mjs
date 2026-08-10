import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadAndValidateRules,
  validateRules
} from '../../lib/route-rules.mjs';

test('loads the checked-in version 1 rules', async () => {
  const rules = await loadAndValidateRules();

  assert.equal(rules.schema_version, 1);
  assert.equal(rules.routing_rule_version, 1);
  assert.equal(rules.thresholds.high_confidence, 80);
  assert.equal(rules.thresholds.minimum_margin, 20);
});

test('rejects unknown routes and target skills', () => {
  const result = validateRules({
    schema_version: 1,
    routing_rule_version: 1,
    thresholds: { high_confidence: 80, minimum_margin: 20 },
    skill_map: { surprise: 'horspowers:unknown' },
    routes: [],
    conflicts: [],
    direct: { allow_rules: [], deny_patterns: [] }
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /unknown route|unknown target_skill/i);
});

test('rejects incompatible schema versions', () => {
  const result = validateRules({ schema_version: 999 });

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /schema_version/i);
});
