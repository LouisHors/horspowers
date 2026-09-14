import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createHpsRuntime } from './hps-runtime.mjs';
import { dispatchHpsOperation } from './hps-operations.mjs';
import { planAgentsBlock } from './agents-managed-block.mjs';
import { routeRequest } from './workflow-router.mjs';

const TEMPLATE_PATH = fileURLToPath(new URL('../skills/using-horspowers/templates/codex-agents-managed-block.md', import.meta.url));

function legacyProjectStatuses(project) {
  const configAction = project?.config_action ?? project?.config_state;
  const docsAction = project?.docs_action;
  return {
    config: configAction === 'unchanged' || configAction === 'valid' ? 'unchanged'
      : configAction === 'skipped' || configAction === 'skipped_disabled' ? configAction
        : project?.eligibility === 'external_project' ? 'external_required' : 'unchanged',
    docs: docsAction === 'unchanged' ? 'unchanged'
      : docsAction === 'skipped' || docsAction === 'skipped_disabled' ? docsAction
        : project?.eligibility === 'external_project' ? 'skipped' : 'unchanged'
  };
}

function legacyOutput({ prepared, agentsStatus, context = null }) {
  const project = prepared.project ?? {};
  const statuses = legacyProjectStatuses(project);
  const external = project.eligibility === 'external_project';
  const contextProject = context?.project ?? {};
  const documentation = context?.documentation ?? {};
  return {
    schema_version: 1,
    device: { agents_block: agentsStatus, router_version: 1 },
    project: {
      eligibility: project.eligibility ?? 'skipped',
      config: statuses.config,
      docs: statuses.docs,
      identity_status: contextProject.identity_status ?? null,
      project_id: contextProject.project_id ?? null,
      project_fingerprint: contextProject.project_fingerprint ?? null,
      config_source: context?.config?.source ?? (external ? 'none' : null),
      documentation_backend: documentation.backend ?? (external ? 'disabled' : null),
      documentation_status: context?.status ?? (external ? 'context_unavailable' : null),
      auto_submit: documentation.auto_submit === true
    },
    routing: prepared.routing,
    mutations: [
      { kind: 'agents_block', status: agentsStatus },
      { kind: 'project_config', status: statuses.config },
      { kind: 'docs', status: statuses.docs }
    ]
  };
}

function requiresLegacyApply(prepared, agentsPlan) {
  if (agentsPlan?.status !== 'unchanged' && agentsPlan?.status !== 'skipped') return true;
  const project = prepared?.project ?? {};
  const configNeedsApply = ![
    'unchanged', 'valid', 'skipped', 'skipped_disabled', 'external_required'
  ].includes(project.config_action);
  const docsNeedsApply = ![
    'unchanged', 'skipped', 'skipped_disabled'
  ].includes(project.docs_action);
  return configNeedsApply || docsNeedsApply;
}

async function defaultPrepare(input) {
  if (!['codex', 'claude'].includes(input.host)) return null;
  const runtime = createHpsRuntime();
  try {
    const prepared = await dispatchHpsOperation({
      runtime,
      operation: 'task_prepare',
      cwd: input.cwd,
      input: {
        message: input.message,
        active_route: input.active_route,
        host: input.host
      }
    });
    let context = null;
    if (prepared?.project?.eligibility === 'external_project' && prepared.scope?.scope_id) {
      context = await dispatchHpsOperation({
        runtime,
        operation: 'project_context',
        cwd: input.cwd,
        input: { scope_id: prepared.scope.scope_id }
      });
    }
    return { prepared, context };
  } finally {
    await runtime.close?.();
  }
}

export async function routeRequestWithHps(input, {
  prepare = defaultPrepare,
  legacy = routeRequest,
  planAgents = ({ host }) => planAgentsBlock({ host, homeDir: homedir(), templatePath: TEMPLATE_PATH })
} = {}) {
  let bridgeResult;
  try {
    bridgeResult = await prepare(input);
  } catch {
    bridgeResult = null;
  }
  if (!bridgeResult?.prepared?.routing || !bridgeResult.prepared.project) return legacy(input);

  const agentsPlan = await planAgents({ host: input.host });
  if (requiresLegacyApply(bridgeResult.prepared, agentsPlan)) return legacy(input);

  // Keep the bridge result equivalent to the old stable envelope while never
  // invoking the legacy route on an unchanged steady-state request.
  return legacyOutput({
    prepared: bridgeResult.prepared,
    agentsStatus: agentsPlan.status,
    context: bridgeResult.context
  });
}
