#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadAndValidateRules } from '../../../lib/route-rules.mjs';
import { classifyRequest } from '../../../lib/workflow-router.mjs';

const CORPUS_PATH = fileURLToPath(new URL('../corpus.yaml', import.meta.url));
const VALIDATE_ONLY = process.argv.slice(2).includes('--validate-only');
const ORIGINAL_POSITIVE_IDS = new Set([
  'brainstorming_strong_001', 'brainstorming_strong_002', 'brainstorming_weak_001', 'brainstorming_weak_002',
  'brainstorming_confusion_001', 'brainstorming_confusion_002', 'writing_plans_strong_001', 'writing_plans_strong_002',
  'writing_plans_weak_001', 'writing_plans_weak_002', 'writing_plans_confusion_001', 'writing_plans_confusion_002',
  'executing_plans_strong_001', 'executing_plans_strong_002', 'executing_plans_weak_001', 'executing_plans_weak_002',
  'executing_plans_confusion_001', 'executing_plans_confusion_002', 'subagent_dev_strong_001', 'subagent_dev_strong_002',
  'subagent_dev_weak_001', 'subagent_dev_weak_002', 'subagent_dev_confusion_001', 'subagent_dev_confusion_002',
  'systematic_debugging_strong_001', 'systematic_debugging_strong_002', 'systematic_debugging_weak_001', 'systematic_debugging_weak_002',
  'systematic_debugging_confusion_001', 'systematic_debugging_confusion_002', 'tdd_strong_001', 'tdd_strong_002',
  'tdd_weak_001', 'tdd_weak_002', 'tdd_confusion_001', 'tdd_confusion_002', 'code_review_strong_001',
  'code_review_strong_002', 'code_review_weak_001', 'code_review_weak_002', 'code_review_confusion_001',
  'code_review_confusion_002', 'document_management_strong_001', 'document_management_strong_002',
  'document_management_weak_001', 'document_management_weak_002', 'document_management_confusion_001',
  'document_management_confusion_002'
]);
const SKILL_TO_ROUTE = new Map([
  ['brainstorming', 'brainstorming'],
  ['systematic-debugging', 'debugging'],
  ['test-driven-development', 'tdd'],
  ['writing-plans', 'planning'],
  ['executing-plans', 'checkpoint_execution'],
  ['subagent-driven-development', 'continuous_execution'],
  ['requesting-code-review', 'code_review'],
  ['document-management', 'docs']
]);
const NEGATIVE_CATEGORIES = new Set(['text_transform', 'calculation_conversion', 'short_explanation', 'command_syntax']);
const PROJECT_TERMS = /(项目|仓库|模块|代码|功能|测试|分支|workflow|router|skill|plugin|docs|git)/iu;

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '[]') return [];
  if (value.startsWith('[') || value.startsWith('{') || value.startsWith('"')) return JSON.parse(value);
  return value;
}

function parseCorpus(source) {
  const entries = [];
  let entry = null;
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = line.match(/^\s*(?:- )?([a-z_]+):\s*(.*)$/u);
    if (!match) throw new Error(`unsupported corpus YAML at line ${index + 1}`);
    const [, key, rawValue] = match;
    if (line.trimStart().startsWith('- ')) {
      if (key !== 'id') throw new Error(`corpus entry must begin with id at line ${index + 1}`);
      entry = {};
      entries.push(entry);
    }
    if (!entry) throw new Error(`corpus entry is missing id before line ${index + 1}`);
    entry[key] = parseScalar(rawValue);
  }
  return entries;
}

function validateCorpus(entries) {
  const errors = [];
  const ids = new Set();
  const positives = entries.filter((entry) => entry.should_trigger === true);
  const negatives = entries.filter((entry) => entry.should_trigger === false);
  const negativeCounts = new Map([...NEGATIVE_CATEGORIES].map((category) => [category, 0]));

  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !entry.id) errors.push('every corpus entry requires a non-empty id');
    else if (ids.has(entry.id)) errors.push(`duplicate corpus id: ${entry.id}`);
    else ids.add(entry.id);
    if (typeof entry.user_message !== 'string' || !entry.user_message) errors.push(`${entry.id}: user_message is required`);
    if (typeof entry.should_trigger !== 'boolean') errors.push(`${entry.id}: should_trigger must be boolean`);
    if (!Array.isArray(entry.secondary_ok_skills)) errors.push(`${entry.id}: secondary_ok_skills must be an array`);
    if (typeof entry.expected_route !== 'string' || !entry.expected_route) errors.push(`${entry.id}: expected_route is required`);

    if (entry.should_trigger === true) {
      if (!SKILL_TO_ROUTE.has(entry.expected_skill)) errors.push(`${entry.id}: unknown expected_skill`);
      if (entry.expected_route !== SKILL_TO_ROUTE.get(entry.expected_skill)) errors.push(`${entry.id}: expected_route must match expected_skill`);
    }
    if (entry.should_trigger === false) {
      if (entry.expected_skill !== '') errors.push(`${entry.id}: negative expected_skill must be empty`);
      if (!['direct', 'uncertain'].includes(entry.expected_route)) errors.push(`${entry.id}: negative expected_route must be direct or uncertain`);
      if (!NEGATIVE_CATEGORIES.has(entry.negative_category)) errors.push(`${entry.id}: negative_category is invalid`);
      else negativeCounts.set(entry.negative_category, negativeCounts.get(entry.negative_category) + 1);
    }
  }

  if (positives.length !== ORIGINAL_POSITIVE_IDS.size) errors.push(`expected ${ORIGINAL_POSITIVE_IDS.size} positive corpus entries, got ${positives.length}`);
  for (const id of ORIGINAL_POSITIVE_IDS) {
    if (!ids.has(id)) errors.push(`original positive corpus id is missing: ${id}`);
  }
  for (const entry of positives) {
    if (!ORIGINAL_POSITIVE_IDS.has(entry.id)) errors.push(`unexpected positive corpus id: ${entry.id}`);
  }
  if (negatives.length < 24) errors.push(`expected at least 24 negative corpus entries, got ${negatives.length}`);
  for (const category of NEGATIVE_CATEGORIES) {
    if ((negativeCounts.get(category) ?? 0) < 6) errors.push(`expected at least 6 negative entries for ${category}`);
  }
  const boundaryNegatives = negatives.filter((entry) => entry.expected_route === 'uncertain' && PROJECT_TERMS.test(entry.user_message ?? ''));
  if (boundaryNegatives.length < 8) errors.push(`expected at least 8 project-term boundary negatives routed uncertain, got ${boundaryNegatives.length}`);
  return { errors, positives, negatives };
}

function routeSkillName(route, rules) {
  return rules.skill_map[route] ?? null;
}

async function main() {
  const entries = parseCorpus(await readFile(CORPUS_PATH, 'utf8'));
  const { errors, positives, negatives } = validateCorpus(entries);
  if (errors.length > 0) {
    process.stdout.write(`${JSON.stringify({ validation_errors: errors }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  if (VALIDATE_ONLY) {
    process.stdout.write(`${JSON.stringify({ valid: true, positive_total: positives.length, negative_total: negatives.length })}\n`);
    return;
  }

  const rules = await loadAndValidateRules();
  const positive = { exact: 0, acceptable: 0, miss: 0, wrong: 0 };
  let overTrigger = 0;
  const failures = [];
  for (const entry of entries) {
    const routing = classifyRequest({ message: entry.user_message, active_route: null }, rules);
    const expectedTarget = routeSkillName(entry.expected_route, rules);
    if (entry.should_trigger) {
      if (routing.target_skill === expectedTarget) positive.exact += 1;
      else if (entry.secondary_ok_skills.includes((routing.target_skill ?? '').replace('horspowers:', ''))) positive.acceptable += 1;
      else if (routing.target_skill === null) {
        positive.miss += 1;
        failures.push({ id: entry.id, expected_route: entry.expected_route, actual_route: routing.route, outcome: 'miss' });
      } else {
        positive.wrong += 1;
        failures.push({ id: entry.id, expected_route: entry.expected_route, actual_route: routing.route, outcome: 'wrong' });
      }
    } else if (routing.target_skill !== null) {
      overTrigger += 1;
      failures.push({ id: entry.id, expected_route: entry.expected_route, actual_route: routing.route, outcome: 'over-trigger' });
    } else if (routing.route !== entry.expected_route) {
      failures.push({ id: entry.id, expected_route: entry.expected_route, actual_route: routing.route, outcome: 'wrong-negative-route' });
    }
  }
  const result = {
    positive,
    negative: { total: negatives.length, over_trigger: overTrigger, rate: negatives.length === 0 ? 0 : overTrigger / negatives.length },
    failures
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (positive.miss > 0 || positive.wrong > 0 || overTrigger / negatives.length > 0.05 || failures.some(({ outcome }) => outcome === 'wrong-negative-route')) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
