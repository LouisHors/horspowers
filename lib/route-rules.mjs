import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const KNOWN_ROUTES = new Set([
  'direct',
  'brainstorming',
  'debugging',
  'tdd',
  'planning',
  'checkpoint_execution',
  'continuous_execution',
  'code_review',
  'docs',
  'uncertain'
]);

export const KNOWN_TARGET_SKILLS = new Set([
  'horspowers:brainstorming',
  'horspowers:systematic-debugging',
  'horspowers:test-driven-development',
  'horspowers:writing-plans',
  'horspowers:executing-plans',
  'horspowers:subagent-driven-development',
  'horspowers:requesting-code-review',
  'horspowers:document-management'
]);

const REQUIRED_TOP_LEVEL_KEYS = new Set([
  'schema_version',
  'routing_rule_version',
  'thresholds',
  'skill_map',
  'routes',
  'conflicts',
  'direct'
]);
const REQUIRED_THRESHOLD_KEYS = new Set([
  'explicit',
  'strong_pair',
  'weak',
  'conflict_cap',
  'high_confidence',
  'minimum_margin'
]);
const REQUIRED_ROUTE_KEYS = new Set([
  'route',
  'explicit_patterns',
  'strong_groups',
  'weak_patterns'
]);
const REQUIRED_GROUP_KEYS = new Set(['id', 'any_patterns']);
const REQUIRED_CONFLICT_KEYS = new Set(['routes', 'prefer', 'when_both', 'score_cap']);
const REQUIRED_PREFERENCE_KEYS = new Set(['route', 'any_patterns']);
const REQUIRED_DIRECT_KEYS = new Set(['allow_rules', 'deny_patterns']);
const REQUIRED_ALLOW_RULE_KEYS = new Set(['id', 'any_patterns']);
const EXPECTED_CONFLICTS = new Set([
  'brainstorming|planning',
  'debugging|tdd',
  'checkpoint_execution|continuous_execution',
  'brainstorming|code_review'
]);
const ROUTABLE_ROUTES = [...KNOWN_ROUTES].filter(
  (route) => route !== 'direct' && route !== 'uncertain'
);

export const DEFAULT_RULES_PATH = fileURLToPath(
  new URL('../skills/using-horspowers/references/route-rules.json', import.meta.url)
);

function hasExactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function pairId(routes) {
  return [...routes].sort().join('|');
}

function addUnexpectedKeyErrors(value, expected, label, errors) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) errors.push(`${label} has unknown key: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`${label} is missing key: ${key}`);
    }
  }
}

export function validateRules(rules) {
  const errors = [];

  if (!isPlainObject(rules)) {
    return { valid: false, errors: ['rules must be an object'] };
  }

  addUnexpectedKeyErrors(rules, REQUIRED_TOP_LEVEL_KEYS, 'rules', errors);

  if (rules.schema_version !== 1) {
    errors.push(`Unsupported schema_version: ${String(rules.schema_version)}`);
  }
  if (!Number.isInteger(rules.routing_rule_version) || rules.routing_rule_version < 1) {
    errors.push('routing_rule_version must be a positive integer');
  }

  addUnexpectedKeyErrors(rules.thresholds, REQUIRED_THRESHOLD_KEYS, 'thresholds', errors);
  if (isPlainObject(rules.thresholds)) {
    for (const key of REQUIRED_THRESHOLD_KEYS) {
      if (!Number.isFinite(rules.thresholds[key]) || rules.thresholds[key] < 0) {
        errors.push(`thresholds.${key} must be a non-negative finite number`);
      }
    }
  }

  if (!isPlainObject(rules.skill_map)) {
    errors.push('skill_map must be an object');
  } else {
    const skillMapKeys = new Set(Object.keys(rules.skill_map));
    for (const route of KNOWN_ROUTES) {
      if (!skillMapKeys.has(route)) errors.push(`skill_map is missing route: ${route}`);
    }
    for (const route of skillMapKeys) {
      if (!KNOWN_ROUTES.has(route)) errors.push(`Unknown route in skill_map: ${route}`);
      const targetSkill = rules.skill_map[route];
      if ((route === 'direct' || route === 'uncertain') && targetSkill !== null) {
        errors.push(`skill_map.${route} must be null`);
      }
      if (route !== 'direct' && route !== 'uncertain' && !KNOWN_TARGET_SKILLS.has(targetSkill)) {
        errors.push(`Unknown target skill for ${route}: ${String(targetSkill)}`);
      }
    }
  }

  const routeNames = new Set();
  if (!Array.isArray(rules.routes)) {
    errors.push('routes must be an array');
  } else {
    for (const [index, routeRule] of rules.routes.entries()) {
      const label = `routes[${index}]`;
      addUnexpectedKeyErrors(routeRule, REQUIRED_ROUTE_KEYS, label, errors);
      if (!isPlainObject(routeRule)) continue;
      if (!KNOWN_ROUTES.has(routeRule.route) || routeRule.route === 'direct' || routeRule.route === 'uncertain') {
        errors.push(`${label}.route is unknown or not routable: ${String(routeRule.route)}`);
      } else if (routeNames.has(routeRule.route)) {
        errors.push(`${label}.route is duplicated: ${routeRule.route}`);
      } else {
        routeNames.add(routeRule.route);
      }
      if (!hasStringArray(routeRule.explicit_patterns)) errors.push(`${label}.explicit_patterns must be a non-empty string array`);
      if (!hasStringArray(routeRule.weak_patterns)) errors.push(`${label}.weak_patterns must be a non-empty string array`);
      if (!Array.isArray(routeRule.strong_groups) || routeRule.strong_groups.length !== 2) {
        errors.push(`${label}.strong_groups must contain exactly two groups`);
      } else {
        const groupIds = new Set();
        for (const [groupIndex, group] of routeRule.strong_groups.entries()) {
          const groupLabel = `${label}.strong_groups[${groupIndex}]`;
          addUnexpectedKeyErrors(group, REQUIRED_GROUP_KEYS, groupLabel, errors);
          if (!isPlainObject(group)) continue;
          if (!isNonEmptyString(group.id)) errors.push(`${groupLabel}.id must be a non-empty string`);
          if (groupIds.has(group.id)) errors.push(`${groupLabel}.id is duplicated: ${group.id}`);
          groupIds.add(group.id);
          if (!hasStringArray(group.any_patterns)) errors.push(`${groupLabel}.any_patterns must be a non-empty string array`);
        }
      }
    }
    for (const route of ROUTABLE_ROUTES) {
      if (!routeNames.has(route)) errors.push(`routes is missing route: ${route}`);
    }
  }

  const conflictPairs = new Set();
  if (!Array.isArray(rules.conflicts)) {
    errors.push('conflicts must be an array');
  } else {
    for (const [index, conflict] of rules.conflicts.entries()) {
      const label = `conflicts[${index}]`;
      addUnexpectedKeyErrors(conflict, REQUIRED_CONFLICT_KEYS, label, errors);
      if (!isPlainObject(conflict)) continue;
      if (!Array.isArray(conflict.routes) || conflict.routes.length !== 2 ||
          conflict.routes.some((route) => !ROUTABLE_ROUTES.includes(route)) ||
          conflict.routes[0] === conflict.routes[1]) {
        errors.push(`${label}.routes must contain two distinct known routable routes`);
      } else {
        const id = pairId(conflict.routes);
        if (conflictPairs.has(id)) errors.push(`${label}.routes is duplicated: ${id}`);
        conflictPairs.add(id);
      }
      if (!Array.isArray(conflict.prefer) || conflict.prefer.length < 2) {
        errors.push(`${label}.prefer must include at least two preferences`);
      } else {
        for (const [preferenceIndex, preference] of conflict.prefer.entries()) {
          const preferenceLabel = `${label}.prefer[${preferenceIndex}]`;
          addUnexpectedKeyErrors(preference, REQUIRED_PREFERENCE_KEYS, preferenceLabel, errors);
          if (!isPlainObject(preference)) continue;
          if (!Array.isArray(conflict.routes) || !conflict.routes.includes(preference.route)) {
            errors.push(`${preferenceLabel}.route must be part of the conflict`);
          }
          if (!hasStringArray(preference.any_patterns)) errors.push(`${preferenceLabel}.any_patterns must be a non-empty string array`);
        }
      }
      if (conflict.when_both !== 'uncertain') errors.push(`${label}.when_both must be uncertain`);
      if (!Number.isFinite(conflict.score_cap) || conflict.score_cap < 0) errors.push(`${label}.score_cap must be a non-negative finite number`);
    }
    for (const expectedPair of EXPECTED_CONFLICTS) {
      if (!conflictPairs.has(expectedPair)) errors.push(`conflicts is missing required pair: ${expectedPair}`);
    }
  }

  addUnexpectedKeyErrors(rules.direct, REQUIRED_DIRECT_KEYS, 'direct', errors);
  if (isPlainObject(rules.direct)) {
    if (!Array.isArray(rules.direct.allow_rules) || rules.direct.allow_rules.length < 4) {
      errors.push('direct.allow_rules must contain at least four rules');
    } else {
      const ids = new Set();
      for (const [index, allowRule] of rules.direct.allow_rules.entries()) {
        const label = `direct.allow_rules[${index}]`;
        addUnexpectedKeyErrors(allowRule, REQUIRED_ALLOW_RULE_KEYS, label, errors);
        if (!isPlainObject(allowRule)) continue;
        if (!isNonEmptyString(allowRule.id)) errors.push(`${label}.id must be a non-empty string`);
        if (ids.has(allowRule.id)) errors.push(`${label}.id is duplicated: ${allowRule.id}`);
        ids.add(allowRule.id);
        if (!hasStringArray(allowRule.any_patterns)) errors.push(`${label}.any_patterns must be a non-empty string array`);
      }
    }
    if (!hasStringArray(rules.direct.deny_patterns)) errors.push('direct.deny_patterns must be a non-empty string array');
  }

  return { valid: errors.length === 0, errors };
}

export async function loadAndValidateRules(rulesPath = DEFAULT_RULES_PATH) {
  const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
  const result = validateRules(rules);
  if (!result.valid) throw new Error(result.errors.join('; '));
  return rules;
}
