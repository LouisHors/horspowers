import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { KNOWN_ROUTES, loadAndValidateRules } from './route-rules.mjs';
import { applyAgentsBlock, planAgentsBlock } from './agents-managed-block.mjs';
import {
  applyProjectInitialization,
  planProjectInitialization
} from './project-initializer.mjs';

const INPUT_SCHEMA_VERSION = 1;
const MAX_MESSAGE_BYTES = 4 * 1024;
const VALID_HOSTS = new Set(['codex', 'claude', 'other']);
const CONTINUATION_ONLY_PATTERNS = new Set([
  '继续',
  '继续做',
  '按刚才继续',
  'continue',
  'go on',
  'proceed'
]);
const ROUTABLE_ROUTES = new Set(
  [...KNOWN_ROUTES].filter((route) => route !== 'direct' && route !== 'uncertain')
);
const INPUT_KEYS = new Set(['schema_version', 'host', 'cwd', 'message', 'active_route']);
const MANAGED_BLOCK_TEMPLATE_PATH = fileURLToPath(
  new URL('../skills/using-horspowers/templates/codex-agents-managed-block.md', import.meta.url)
);

const defaultDependencies = {
  loadRules: () => loadAndValidateRules(process.env.HORSPOWERS_ROUTE_RULES_PATH || undefined),
  planAgents: ({ host }) => planAgentsBlock({
    host,
    homeDir: homedir(),
    templatePath: MANAGED_BLOCK_TEMPLATE_PATH
  }),
  planProject: ({ cwd }) => planProjectInitialization({
    cwd,
    homeDir: homedir(),
    tempDir: tmpdir()
  }),
  applyAgents: (plan) => applyAgentsBlock(plan),
  applyProject: (plan) => applyProjectInitialization(plan)
};

export class InputContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputContractError';
    this.exitCode = 64;
  }
}

function normalizeMessage(message) {
  return message.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function normalizeContinuation(message) {
  return normalizeMessage(message)
    .replace(/[，。！？,.!?、:：；;()（）'"`]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function toRegex(pattern) {
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    throw new Error(`Invalid route pattern: ${pattern}`);
  }
}

function matchingPatterns(message, patterns) {
  return patterns.filter((pattern) => toRegex(pattern).test(message));
}

function validateInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InputContractError('route request must be a JSON object');
  }
  const keys = Object.keys(input);
  if (keys.length !== INPUT_KEYS.size || keys.some((key) => !INPUT_KEYS.has(key))) {
    throw new InputContractError('route request fields are invalid');
  }
  if (input.schema_version !== INPUT_SCHEMA_VERSION) {
    throw new InputContractError('unsupported input schema_version');
  }
  if (!VALID_HOSTS.has(input.host)) {
    throw new InputContractError('host must be codex, claude, or other');
  }
  if (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) {
    throw new InputContractError('cwd must be an absolute path');
  }
  if (typeof input.message !== 'string' || Buffer.byteLength(input.message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new InputContractError('message must be at most 4 KiB');
  }
  if (input.active_route !== null && !ROUTABLE_ROUTES.has(input.active_route)) {
    throw new InputContractError('active_route must be null or a known routable route');
  }
  return input;
}

function resultFor(route, score, rules, matchedRules, candidates) {
  return {
    route,
    target_skill: rules.skill_map[route] ?? null,
    confidence: Number((score / 100).toFixed(2)),
    routing_rule_version: rules.routing_rule_version,
    matched_rules: matchedRules,
    candidates,
    context_policy: route === 'brainstorming' ? 'parallel_background' : 'none'
  };
}

function addCandidate(scores, matches, route, score, match) {
  const current = scores.get(route) ?? 0;
  if (score > current) scores.set(route, score);
  const routeMatches = matches.get(route) ?? [];
  routeMatches.push(match);
  matches.set(route, routeMatches);
}

export function classifyRequest({ message, active_route = null }, rules) {
  const normalized = normalizeMessage(message);
  const scores = new Map();
  const matches = new Map();

  const deniedDirectPatterns = matchingPatterns(normalized, rules.direct.deny_patterns);
  if (deniedDirectPatterns.length === 0) {
    for (const allowRule of rules.direct.allow_rules) {
      const hits = matchingPatterns(normalized, allowRule.any_patterns);
      if (hits.length > 0) addCandidate(scores, matches, 'direct', rules.thresholds.explicit, `direct:${allowRule.id}`);
    }
  }

  for (const routeRule of rules.routes) {
    const explicitHits = matchingPatterns(normalized, routeRule.explicit_patterns);
    if (explicitHits.length > 0) {
      addCandidate(scores, matches, routeRule.route, rules.thresholds.explicit, `explicit:${explicitHits[0]}`);
      continue;
    }

    const groupHits = routeRule.strong_groups.map((group) => ({
      id: group.id,
      hits: matchingPatterns(normalized, group.any_patterns)
    }));
    if (groupHits.every(({ hits }) => hits.length > 0)) {
      addCandidate(
        scores,
        matches,
        routeRule.route,
        rules.thresholds.strong_pair,
        `strong:${groupHits.map(({ id }) => id).join('+')}`
      );
      continue;
    }

    const weakHits = matchingPatterns(normalized, routeRule.weak_patterns);
    if (weakHits.length > 0) addCandidate(scores, matches, routeRule.route, rules.thresholds.weak, `weak:${weakHits[0]}`);
  }

  const continuation = normalizeContinuation(message);
  const hasCurrentIntent = [...scores.keys()].some((route) => route !== 'direct');
  if (!hasCurrentIntent && active_route !== null && CONTINUATION_ONLY_PATTERNS.has(continuation)) {
    addCandidate(scores, matches, active_route, rules.thresholds.strong_pair, `continuation:${active_route}`);
  }

  for (const conflict of rules.conflicts) {
    const [firstRoute, secondRoute] = conflict.routes;
    if ((scores.get(firstRoute) ?? 0) > 0 && (scores.get(secondRoute) ?? 0) > 0) {
      scores.set(firstRoute, Math.min(scores.get(firstRoute), conflict.score_cap));
      scores.set(secondRoute, Math.min(scores.get(secondRoute), conflict.score_cap));
      matches.set(firstRoute, [...(matches.get(firstRoute) ?? []), `conflict:${secondRoute}`]);
      matches.set(secondRoute, [...(matches.get(secondRoute) ?? []), `conflict:${firstRoute}`]);
    }
  }

  const ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort(([firstRoute, firstScore], [secondRoute, secondScore]) => secondScore - firstScore || firstRoute.localeCompare(secondRoute));
  const candidates = ranked.map(([route]) => route);
  const [winner, runnerUp] = ranked;

  if (!winner || winner[1] < rules.thresholds.high_confidence ||
      (runnerUp && winner[1] - runnerUp[1] < rules.thresholds.minimum_margin)) {
    return resultFor('uncertain', 0, rules, [], candidates);
  }

  const [route, score] = winner;
  return resultFor(route, score, rules, matches.get(route) ?? [], candidates);
}

function fallbackUncertain(error) {
  const routingError = /schema_version|version/iu.test(error instanceof Error ? error.message : String(error))
    ? 'RULES_VERSION_UNSUPPORTED'
    : 'RULES_INVALID';
  return {
    route: 'uncertain',
    target_skill: null,
    confidence: 0,
    routing_rule_version: null,
    matched_rules: [],
    candidates: [],
    context_policy: 'none',
    routing_error: routingError
  };
}

function buildUncertainWithoutMutations(routingError) {
  return {
    schema_version: INPUT_SCHEMA_VERSION,
    device: { agents_block: 'skipped', router_version: 1 },
    project: { eligibility: 'skipped', config: 'skipped', docs: 'skipped' },
    routing: {
      route: 'uncertain',
      target_skill: null,
      confidence: 0,
      routing_rule_version: null,
      matched_rules: [],
      candidates: [],
      context_policy: 'none',
      routing_error: routingError
    },
    mutations: []
  };
}

async function applyWithStatus(apply, plan, fallbackKind) {
  try {
    return await apply(plan);
  } catch (error) {
    return {
      status: 'failed',
      kind: fallbackKind,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildStableOutput({ routing, agents, project, projectPlan }) {
  const config = project?.config ?? { status: 'failed' };
  const docs = project?.docs ?? { status: 'failed' };
  return {
    schema_version: INPUT_SCHEMA_VERSION,
    device: { agents_block: agents.status, router_version: 1 },
    project: {
      eligibility: projectPlan.eligibility,
      config: config.status,
      docs: docs.status
    },
    routing,
    mutations: [
      { kind: 'agents_block', status: agents.status },
      { kind: 'project_config', status: config.status },
      { kind: 'docs', status: docs.status }
    ]
  };
}

export async function routeRequest(input, dependencies = {}) {
  validateInput(input);
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  let routing;
  try {
    const rules = await resolvedDependencies.loadRules();
    routing = classifyRequest(input, rules);
  } catch (error) {
    return buildUncertainWithoutMutations(fallbackUncertain(error).routing_error);
  }

  let agentsPlan;
  let projectPlan;
  try {
    agentsPlan = await resolvedDependencies.planAgents({ host: input.host });
    projectPlan = await resolvedDependencies.planProject({ cwd: input.cwd });
  } catch {
    return buildUncertainWithoutMutations('PLAN_FAILED');
  }
  if (agentsPlan.status === 'failed' || projectPlan.status === 'failed') {
    return buildUncertainWithoutMutations('PLAN_FAILED');
  }

  const agents = await applyWithStatus(resolvedDependencies.applyAgents, agentsPlan, 'agents_block');
  const project = await applyWithStatus(resolvedDependencies.applyProject, projectPlan, 'project');
  return buildStableOutput({ routing, agents, project, projectPlan });
}
