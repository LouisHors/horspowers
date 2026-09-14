import { homedir, tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { classifyRequest } from './workflow-router.mjs';
import { loadAndValidateRules } from './route-rules.mjs';
import { planProjectInitialization } from './project-initializer.mjs';
import { resolveProjectContext } from './project-context.mjs';
import { identifyGitProject } from './project-identity.mjs';
import { defaultHostConfigPath, readHostConfig } from './host-config.mjs';
import { resolveWikiProjectConfig } from './wiki-config-provider.mjs';
import { readConfigAtRoot } from './config-manager.js';
import { collectContext } from '../skills/brainstorming/scripts/collect-context.mjs';
import { DocumentRuntime } from './document-runtime.mjs';
import { VERIFICATION_PROFILES, runVerificationProfile } from './hps-verification.mjs';
import { HPS_CAPABILITY_KEYS, HPS_HOSTS, adaptHostCapabilities, isTrustedCapabilityAdapter } from './hps-capabilities.mjs';

const DEFAULT_CAPABILITIES = Object.freeze(
  Object.fromEntries(HPS_CAPABILITY_KEYS.map((key) => [key, false]))
);

export { VERIFICATION_PROFILES };
const execFileAsync = promisify(execFile);
const SENSITIVE_PATH = /^(?:\.env(?:\..*)?$|.*(?:credential|secret|password|token).*)$/iu;
const SCOPE_FACT_KEYS = Object.freeze([
  'root', 'git_identity_digest', 'project_fingerprint', 'revision',
  'config_revision', 'config_hash', 'manifest_revision', 'manifest_hash',
  'host_config_digest', 'transport_digest'
]);

function scopeToken() {
  return randomBytes(18).toString('base64url');
}

function assertCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new TypeError('cwd must be absolute');
}

function parseAheadBehind(value) {
  const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(value ?? '');
  return match ? { ahead: Number(match[1]), behind: Number(match[2]) } : { ahead: null, behind: null };
}

function isSensitivePath(value) {
  // Git may report a nested path (for example `config/.env.local`). Apply
  // the filename policy to every path component so a sensitive basename can
  // never escape merely because it is not at the repository root.
  const normalized = String(value ?? '').trim().replace(/^"|"$/gu, '');
  return normalized.split(/[\\/]/u).some((segment) => SENSITIVE_PATH.test(segment));
}

function parseStatus(value) {
  const lines = String(value ?? '').split(/\r?\n/u).filter(Boolean);
  const header = lines.find((line) => line.startsWith('## ')) ?? '';
  const files = lines.filter((line) => !line.startsWith('## ')).map((line) => line.slice(3).trim()).filter(Boolean);
  const sensitive = files.filter((file) => isSensitivePath(file));
  return { header, dirty: files.length > 0, files: files.filter((file) => !isSensitivePath(file)), sensitiveCount: sensitive.length };
}

function parseFiles(value) {
  return String(value ?? '').split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    .filter((file) => !isSensitivePath(file));
}

function sanitizeDiffStat(value) {
  return String(value ?? '').split(/\r?\n/u).filter((line) => {
    const marker = line.search(/\s+\|\s/u);
    // `git diff --stat` emits one path row per file and a final summary row.
    // Only inspect the path portion; summary counters are safe and retained.
    const pathPart = marker >= 0 ? line.slice(0, marker).trim() : line.trim();
    return !pathPart || !isSensitivePath(pathPart) || /\bfiles? changed\b/iu.test(pathPart);
  }).join('\n');
}

function defaultRules() {
  return loadAndValidateRules(process.env.HORSPOWERS_ROUTE_RULES_PATH || undefined);
}

function capabilitiesFrom(overrides = {}) {
  const adapter = overrides.capabilityAdapter;
  const adapterInput = adapter !== undefined || overrides.host !== undefined || overrides.hostFacts !== undefined;
  let adapted = null;
  try {
    if (typeof adapter === 'function') adapted = adapter();
    else if (adapter && typeof adapter.resolve === 'function') adapted = adapter.resolve();
    else if (adapter && typeof adapter === 'object' && adapter.capabilities && typeof adapter.capabilities === 'object') {
      adapted = adapter;
    } else if (overrides.host || overrides.hostFacts) {
      adapted = adaptHostCapabilities({
        host: overrides.host,
        facts: overrides.hostFacts,
        sidecarProcessFacts: overrides.sidecarProcessFacts
      });
    }
  } catch {
    adapted = null;
  }
  const supplied = isTrustedCapabilityAdapter(adapted) && HPS_HOSTS.includes(adapted.host) && adapted.verified === true && adapted?.capabilities && typeof adapted.capabilities === 'object'
    ? adapted.capabilities
    : !adapterInput && overrides.capabilities && typeof overrides.capabilities === 'object'
      ? overrides.capabilities
      : {};
  const result = Object.fromEntries(HPS_CAPABILITY_KEYS.map((key) => [
    key,
    // Persistence is a process fact, never a host/operation input flag.
    key === 'persistent_session'
      ? adapted?.persistent_session_source === 'hps-sidecar' && adapted?.capabilities?.persistent_session === true ||
        (adapted === null && overrides.sidecarProcessFacts?.source === 'hps-sidecar' &&
          overrides.sidecarProcessFacts?.verified === true && overrides.sidecarProcessFacts?.persistent_session === true)
      : supplied[key] === true
  ]));
  return result;
}

function capabilityVerificationFrom(overrides = {}) {
  const adapter = overrides.capabilityAdapter;
  if (isTrustedCapabilityAdapter(adapter) && HPS_HOSTS.includes(adapter.host) &&
      (typeof adapter.host !== 'undefined' || typeof adapter.verified !== 'undefined')) {
    return {
      host: adapter.host ?? null,
      verified: adapter.verified === true,
      source: typeof adapter.source === 'string' ? adapter.source : null,
      reason: typeof adapter.reason === 'string' ? adapter.reason : null
    };
  }
  if (overrides.host || overrides.hostFacts || overrides.sidecarProcessFacts) {
    const result = adaptHostCapabilities({
      host: overrides.host,
      facts: overrides.hostFacts,
      sidecarProcessFacts: overrides.sidecarProcessFacts
    });
    return { host: result.host, verified: result.verified, source: result.source, reason: result.reason };
  }
  return { host: null, verified: false, source: null, reason: 'legacy_capability_map' };
}

function revisionFacts(context = {}) {
  return {
    config_revision: context?.config_revision ?? context?.config?.value?.revision ?? null,
    config_hash: context?.config_hash ?? null,
    manifest_revision: context?.manifest_revision ?? context?.wiki?.manifest?.revision ?? null,
    manifest_hash: context?.manifest_hash ?? context?.wiki?.manifest_hash ?? null,
    host_config_digest: context?.host_config_digest ?? context?.wiki?.host_config_digest ?? null,
    transport_digest: context?.transport_digest ?? context?.wiki?.transport_digest ?? null
  };
}

function trustedWikiRootFrom(context = null) {
  const provenance = context?.wiki_root_provenance;
  if (context?.status !== 'ready' || context?.identity_status !== 'external' ||
      context?.wiki_root_trusted !== true || typeof context?.wiki_root !== 'string' ||
      provenance?.source !== 'validated_host_config' || provenance?.field !== 'wiki.local_root' ||
      provenance?.canonical !== true) return null;
  return context.wiki_root;
}

function identityDigest(identity = null) {
  if (!identity || typeof identity !== 'object') return null;
  const facts = {
    kind: identity.kind ?? null,
    project_fingerprint: identity.project_fingerprint ?? null,
    canonical_repository: identity.canonical_repository ?? null,
    reason: identity.reason ?? null,
    candidates: Array.isArray(identity.candidates) ? [...identity.candidates].sort() : null
  };
  return createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex');
}

function valueDigest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
}

function comparableScopeFacts(facts = {}) {
  return Object.fromEntries(SCOPE_FACT_KEYS.flatMap((key) =>
    Object.hasOwn(facts, key) ? [[key, facts[key]]] : []
  ));
}

function scopeFactDigest(facts = {}) {
  const stable = Object.fromEntries(Object.entries(comparableScopeFacts(facts))
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)));
  return createHash('sha256').update(JSON.stringify(stable), 'utf8').digest('hex');
}

function scopeFactsMatch(expected, current) {
  if (!current || typeof current !== 'object') return false;
  for (const key of expected.fact_keys ?? []) {
    if (!Object.hasOwn(current, key) || current[key] !== expected[key]) return false;
  }
  return true;
}

function publicProjectContext(context = null) {
  if (!context || typeof context !== 'object') return null;
  return {
    status: context.status ?? 'context_unavailable',
    project: context.project ?? null,
    config_status: context.config_status ?? 'unavailable',
    documentation: context.documentation ?? null,
    ...revisionFacts(context)
  };
}

function safeRemotePart(value, { path = false } = {}) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/u.test(value)) return null;
  const normalized = value.trim().toLocaleLowerCase('en-US').replace(/\.git$/u, '');
  const pattern = path ? /^[a-z0-9._~/-]+$/u : /^[a-z0-9._~-]+$/u;
  return normalized && pattern.test(normalized) ? normalized : null;
}

function remoteSummary({ identity = null, context = null, git = null } = {}) {
  const source = identity && typeof identity === 'object' ? identity : {};
  const project = context?.project && typeof context.project === 'object' ? context.project : {};
  const canonical = safeRemotePart(source.canonical_repository ?? project.canonical_repository, { path: true });
  const parts = canonical?.split('/') ?? [];
  const host = safeRemotePart(source.remote_host ?? source.host ?? parts.shift(), { path: false });
  const repositoryPath = safeRemotePart(parts.join('/'), { path: true });
  const upstreamValue = safeRemotePart(git?.branch?.upstream, { path: true });
  const upstreamRemote = upstreamValue?.split('/')[0] ?? null;
  const remoteName = safeRemotePart(source.remote_name ?? upstreamRemote, { path: false });
  return {
    status: host && repositoryPath ? 'known' : 'unknown',
    remote_name: remoteName,
    host,
    path: repositoryPath,
    upstream: upstreamValue
  };
}

function snapshotWithRemote(result, { identity = null, context = null, git = null } = {}) {
  const safe = result && typeof result === 'object' ? result : {};
  return { ...safe, remote: remoteSummary({ identity, context, git }) };
}

function dependency(dependencies, names, fallback) {
  for (const name of names) {
    if (typeof dependencies?.[name] === 'function') return dependencies[name];
  }
  return fallback;
}

async function closeQuietly(resource) {
  try {
    await resource?.close?.();
  } catch {
    // Resource cleanup is best effort and must not replace the operation result.
  }
}

function liveScopeFactValidator({ projectPlan, context, dependencies }) {
  if (typeof dependencies.scopeFactValidator === 'function') {
    return (input) => dependencies.scopeFactValidator(input);
  }
  const lower = dependencies.projectContextDependencies ?? {};
  return async ({ scope }) => {
    const root = scope.root;
    const identify = dependency(lower, ['identifyGitProject', 'identifyProject'], identifyGitProject);
    let identity;
    try {
      identity = await identify(root);
    } catch {
      return null;
    }

    let currentContext = null;
    if (identity?.kind === 'company') {
      const readHost = dependency(lower, ['readHostConfig', 'readHost'], readHostConfig);
      const hostPathFor = dependency(lower, ['defaultHostConfigPath', 'hostConfigPath'], defaultHostConfigPath);
      const resolveWiki = dependency(lower, ['resolveWikiProjectConfig', 'resolveWikiConfig'], resolveWikiProjectConfig);
      let hostResult;
      let wikiResult;
      try {
        hostResult = await readHost(hostPathFor(dependencies.homeDir ?? homedir()));
        if (!hostResult?.ok || !hostResult.config || !scope.qmd_client) return null;
        wikiResult = await resolveWiki({
          identity: { ...identity, project_root: root },
          hostConfig: hostResult.config,
          qmdClient: scope.qmd_client
        });
      } catch {
        return null;
      }
      if (wikiResult?.status !== 'ready' || !wikiResult.config) return null;
      currentContext = {
        config_revision: wikiResult.config_revision ?? null,
        config_hash: valueDigest(wikiResult.config),
        manifest_hash: valueDigest(wikiResult.manifest ?? null),
        host_config_digest: valueDigest(hostResult.config),
        transport_digest: valueDigest(hostResult.config?.wiki?.transport ?? null),
        wiki: { manifest: wikiResult.manifest ?? null }
      };
    } else {
      const readLocal = dependency(lower, ['readConfigAtRoot', 'readLocalConfig'], readConfigAtRoot);
      let config;
      try {
        config = readLocal(root);
      } catch {
        return null;
      }
      currentContext = { config_hash: valueDigest(config ?? null) };
    }
    const revisions = revisionFacts(currentContext);
    return {
      root,
      git_identity_digest: identityDigest(identity),
      project_fingerprint: currentContext?.project?.project_fingerprint ?? identity?.project_fingerprint ?? projectPlan?.identity?.project_fingerprint ?? null,
      revision: revisions.manifest_revision ?? revisions.config_revision,
      ...revisions
    };
  };
}

const CONTROL_STATE_FIELDS = Object.freeze({
  route: { type: 'string', maxLength: 96 }, phase: { type: 'string', maxLength: 96 },
  operation: { type: 'string', maxLength: 96 }, skill: { type: 'string', maxLength: 128 },
  status: { type: 'string_or_null', maxLength: 64 }, error_code: { type: 'string_or_null', maxLength: 96 },
  request_id: { type: 'string', maxLength: 256 }, idempotency_key: { type: 'string', maxLength: 256 },
  checkpoint_id: { type: 'string', maxLength: 256 }, logical_id: { type: 'string', maxLength: 128 },
  scope_id: { type: 'string', maxLength: 128 }, step: { type: 'integer' }, attempt: { type: 'integer' },
  index: { type: 'integer' }, count: { type: 'integer' }, total: { type: 'integer' }, revision: { type: 'integer' },
  done: { type: 'boolean' }, completed: { type: 'boolean' }, success: { type: 'boolean' },
  changed: { type: 'boolean' }, dirty: { type: 'boolean' }
});
const MAX_STATE_DEPTH = 6;
const MAX_STATE_NODES = 128;
const MAX_STATE_BYTES = 16_384;

function stateStringIsSafe(value, maximum, field = null) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximum || /[\0\s]/u.test(value)) return false;
  const token = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
  const opaqueId = ['scope_id', 'request_id', 'checkpoint_id', 'idempotency_key'].includes(field);
  const opaqueToken = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
  const namespacedSkill = field === 'skill' && /^horspowers:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
  if (field === 'scope_id' && !/^[A-Za-z0-9_-]{24}$/u.test(value)) return false;
  if (!(namespacedSkill || token.test(value) || (opaqueId && opaqueToken.test(value)))) return false;
  if (/^(?:gh[pousr]_|github_pat_|sk-[a-z0-9]|sk-proj-|AKIA[0-9A-Z]{16})/iu.test(value)) return false;
  if (/^(?:sha256:)?[0-9a-f]{64}$/iu.test(value)) return false;
  if (/(?:bearer|token|password|secret|credential|authorization)/iu.test(value)) return false;
  if (!opaqueId && value.length >= 24 && /^[A-Za-z0-9+_=-]+$/u.test(value) && /[a-z]/u.test(value) && /[A-Z]/u.test(value) && /\d/u.test(value)) return false;
  if (/(?:```|^\s*#{1,6}\s|^\s*(?:diff --git|@@)|(?:^|\s)[+-]{3}(?:\s|$))/mu.test(value)) return false;
  if (/\b(?:function|const|let|var|import|export|class|def|return)\b|=>|[{};]/u.test(value)) return false;
  if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/iu.test(value)) return false;
  return true;
}

function ownDataKeys(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw new TypeError('unsafe session state input');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new TypeError('unsafe session state input');
  }
  return keys;
}

function isPlainStateObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateControlState(value) {
  const seen = new WeakSet();
  let nodes = 0;
  if (!isPlainStateObject(value)) throw new TypeError('unsafe session state input');
  const walk = (current, depth) => {
    if (++nodes > MAX_STATE_NODES || depth > MAX_STATE_DEPTH || !isPlainStateObject(current) || seen.has(current)) throw new TypeError('unsafe session state input');
    seen.add(current);
    const keys = ownDataKeys(current);
    if (keys.length > 32) throw new TypeError('unsafe session state input');
    for (const key of keys) {
      const schema = CONTROL_STATE_FIELDS[key];
      if (!schema) throw new TypeError('unsafe session state input');
      const child = current[key];
      if (child === null) {
        if (schema.type !== 'string_or_null') throw new TypeError('unsafe session state input');
      } else if (schema.type === 'string' || schema.type === 'string_or_null') {
        if (!stateStringIsSafe(child, schema.maxLength, key)) throw new TypeError('unsafe session state input');
      } else if (schema.type === 'integer') {
        if (!Number.isSafeInteger(child) || child < 0) throw new TypeError('unsafe session state input');
      } else if (schema.type === 'boolean') {
        if (typeof child !== 'boolean') throw new TypeError('unsafe session state input');
      } else {
        walk(child, depth + 1);
      }
    }
  };
  walk(value, 0);
}

function validateReferenceState(value) {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError('unsafe session state input');
  const seen = new WeakSet();
  for (const reference of value) {
    if (!validSessionReference(reference) || seen.has(reference)) throw new TypeError('unsafe session state input');
    seen.add(reference);
    ownDataKeys(reference);
    if (!stateStringIsSafe(reference.logical_id, 128, 'logical_id')) throw new TypeError('unsafe session state input');
    if (Object.hasOwn(reference, 'status') && reference.status !== null && !stateStringIsSafe(reference.status, 64, 'status')) throw new TypeError('unsafe session state input');
  }
}

function statePayload(value, { references = false } = {}) {
  if (references) validateReferenceState(value);
  else validateControlState(value);
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw new TypeError('unsafe session state input'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) throw new TypeError('unsafe session state input');
  return serialized;
}

function cloneStateValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new TypeError('unsafe session state input');
  }
}

function boundedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\0\r\n]/u.test(value);
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new Error('cancelled');
}

function validSessionReference(reference) {
  return reference && typeof reference === 'object' && !Array.isArray(reference) &&
    Object.keys(reference).every((key) => ['logical_id', 'status', 'revision'].includes(key)) &&
    typeof reference.logical_id === 'string' && reference.logical_id.length > 0 && reference.logical_id.length <= 128 &&
    !/[\0\r\n]/u.test(reference.logical_id) &&
    (!Object.hasOwn(reference, 'status') || reference.status === null ||
      (typeof reference.status === 'string' && reference.status.length <= 64 && !/[\0\r\n]/u.test(reference.status))) &&
    (!Object.hasOwn(reference, 'revision') || reference.revision === null ||
      (Number.isSafeInteger(reference.revision) && reference.revision >= 0));
}

function nextActionsFor(routing, context, projectPlan) {
  const actions = [];
  if (routing.route === 'uncertain') actions.push('ask_for_intent');
  if (projectPlan?.eligibility === 'external_project' && context?.status !== 'ready') actions.push('resolve_project_context');
  if (routing.target_skill) actions.push(`invoke:${routing.target_skill}`);
  return actions;
}

export class HpsRuntime {
  constructor(dependencies = {}) {
    this.dependencies = dependencies;
    this.documentCache = new Map();
    this.sessionState = new Map();
    this.checkpoints = new Map();
    this.scopes = new Map();
    this.sessionRecords = new Map();
    this.projectSnapshotCache = new Map();
    this.documentReferences = new Map();
    this.now = dependencies.now ?? (() => Date.now());
    this.scopeTtlMs = dependencies.scopeTtlMs ?? 5 * 60_000;
    this.snapshotTtlMs = dependencies.snapshotTtlMs ?? 5_000;
    this.stateTtlMs = dependencies.stateTtlMs ?? 30 * 60_000;
  }

  async taskPrepare(args = {}) {
    const lifecycle = { scope_id: null, qmd_client: null, published: false, cleaned: false };
    try {
      const result = await this.#taskPrepare(args, lifecycle);
      if (args.signal?.aborted) {
        if (lifecycle.scope_id) {
          await this.invalidateScope(lifecycle.scope_id);
          lifecycle.cleaned = true;
        }
        throw new Error('cancelled');
      }
      lifecycle.published = true;
      return result;
    } finally {
      if (!lifecycle.published && !lifecycle.cleaned) {
        if (lifecycle.scope_id) {
          await this.invalidateScope(lifecycle.scope_id);
        } else if (lifecycle.qmd_client && typeof lifecycle.qmd_client.close === 'function') {
          await Promise.resolve().then(() => lifecycle.qmd_client.close()).catch(() => {});
        }
        lifecycle.cleaned = true;
      }
    }
  }

  async #taskPrepare({ cwd, input = {}, signal } = {}, lifecycle = {}) {
    const started = performance.now();
    const deps = this.dependencies;
    const rules = await (deps.loadRules ?? defaultRules)();
    const routing = classifyRequest({
      message: typeof input.message === 'string' ? input.message : '',
      active_route: input.active_route ?? null
    }, rules);

    // Direct requests are intentionally context-free: no Git, config, Wiki or qmd work.
    if (routing.route === 'direct') {
      return {
        routing,
        context: null,
        scope: null,
        next_actions: [],
        capabilities: capabilitiesFrom(deps),
        metrics: { duration_ms: Math.round(performance.now() - started), context_collected: false }
      };
    }

    const planProject = deps.planProject ?? ((options) => planProjectInitialization({
      ...options, homeDir: options.homeDir ?? homedir(), tempDir: options.tempDir ?? tmpdir()
    }));
    const projectPlan = await planProject({ cwd, signal });
    let context = null;
    if (projectPlan?.eligibility === 'external_project') {
      const resolve = deps.resolveProjectContext ?? ((options) => resolveProjectContext(options));
      context = await resolve({ cwd, projectPlan, signal });
      lifecycle.qmd_client = context?.wiki?.qmd_client ?? null;
    }

    let collected = null;
    if (routing.context_policy === 'parallel_background' && context?.status === 'ready') {
      const collect = deps.collectContext ?? collectContext;
      const known = Array.isArray(input.known_entry_files) ? input.known_entry_files : [];
      collected = await collect({
        schema_version: 1,
        cwd,
        query: typeof input.query === 'string' ? input.query : input.message ?? '',
        wiki_root: trustedWikiRootFrom(context),
        known_entry_files: known
      }, { signal, resolveRuntime: async () => context });
    }
    let initialFacts = {
      root: context?.project?.root ?? projectPlan?.project_root ?? cwd,
      git_identity_digest: identityDigest(projectPlan?.identity),
      project_fingerprint: context?.project?.project_fingerprint ?? projectPlan?.identity?.project_fingerprint ?? null,
      ...revisionFacts(context)
    };
    const snapshotValidator = liveScopeFactValidator({ projectPlan, context, dependencies: deps });
    let snapshotValidationUnavailable = false;
    // A local project has no full project-context resolution in task_prepare.
    // Bind its identity/config facts once through the fixed read-only validator
    // so null values are verified facts rather than unbound placeholders.
    if (projectPlan?.eligibility === 'project') {
      try {
        const verified = await snapshotValidator({
          scope: {
            ...initialFacts,
            fact_keys: SCOPE_FACT_KEYS,
            project_plan: projectPlan,
            qmd_client: null
          }
        });
        if (!verified) snapshotValidationUnavailable = true;
        else initialFacts = { ...initialFacts, ...verified };
      } catch {
        snapshotValidationUnavailable = true;
      }
    }
    const factProvider = projectPlan?.eligibility === 'project' ? snapshotValidator : async () => {
      const currentPlan = await planProject({ cwd, signal });
      let currentContext = null;
      if (currentPlan?.eligibility === 'external_project') {
        if (typeof deps.resolveProjectContext === 'function') {
          currentContext = await deps.resolveProjectContext({ cwd, projectPlan: currentPlan, signal });
        } else {
          currentContext = await resolveProjectContext({
            cwd,
            projectRoot: currentPlan?.project_root ?? initialFacts.root,
            identity: currentPlan?.identity,
            dependencies: {
              ...(deps.projectContextDependencies ?? {}),
              ...(context?.wiki?.qmd_client ? { createQmdClient: async () => context.wiki.qmd_client } : {})
            }
          });
        }
      }
      const currentRevisions = revisionFacts(currentContext);
      return {
        root: currentContext?.project?.root ?? currentPlan?.project_root ?? cwd,
        git_identity_digest: identityDigest(currentPlan?.identity),
        project_fingerprint: currentContext?.project?.project_fingerprint ?? currentPlan?.identity?.project_fingerprint ?? null,
        revision: currentRevisions.manifest_revision ?? currentRevisions.config_revision,
        ...currentRevisions
      };
    };
    assertNotAborted(signal);
    return {
      routing,
      context,
      project: projectPlan ?? null,
      collected,
      scope: (() => {
        const root = initialFacts.root;
        const projectFingerprint = initialFacts.project_fingerprint;
        const scope_id = this.openScope({
          ...initialFacts,
          root,
          identity: projectPlan?.identity ?? null,
          project_plan: projectPlan ?? null,
          document_context: context,
          qmd_client: context?.wiki?.qmd_client ?? null,
          snapshot_fact_provider: snapshotValidationUnavailable ? async () => null : snapshotValidator,
          snapshot_validation_unavailable: snapshotValidationUnavailable,
          fact_provider: snapshotValidationUnavailable ? async () => null : factProvider
        });
        lifecycle.scope_id = scope_id;
        return {
          scope_id,
          project_id: context?.project?.project_id ?? null,
          project_fingerprint: projectFingerprint,
          root
        };
      })(),
      next_actions: nextActionsFor(routing, context, projectPlan),
      capabilities: capabilitiesFrom(deps),
      metrics: {
        duration_ms: Math.round(performance.now() - started),
        context_collected: Boolean(collected),
        context_resolved: Boolean(context)
      }
    };
  }

  async projectSnapshot({ cwd, scope_id = null } = {}) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new TypeError('cwd must be absolute');
    // A scoped snapshot must validate the live scope before consulting any
    // cache. This prevents stale snapshots from bypassing fact invalidation.
    const scope = scope_id
      ? await this.assertScope(scope_id, { cwd, useSnapshotProvider: true })
      : null;
    const cacheKey = scope_id ? `${cwd}\u0000${scope_id}` : cwd;
    const cached = this.projectSnapshotCache.get(cacheKey);
    if (cached && cached.expires_at > this.now()) return cached.promise;
    const pending = (async () => {
      const started = performance.now();
      if (scope) {
        const git = await this.gitPreflight({ cwd });
        // The scope may be invalidated while the read-only Git probe is in
        // flight. Re-assert before publishing any result so an invalidated or
        // replaced scope can never yield a ready snapshot.
        const liveScope = await this.assertScope(scope_id, { cwd, useSnapshotProvider: true });
        if (liveScope !== scope || liveScope.fact_digest !== scope.fact_digest) {
          this.invalidateScope(scope_id);
          throw new Error('scope_expired');
        }
        const context = liveScope.document_context ?? null;
        const result = {
          root: liveScope.root ?? context?.project?.root ?? cwd,
          eligibility: liveScope.project_plan?.eligibility ?? (context?.identity_status === 'company' ? 'external_project' : 'unknown'),
          identity: {
            kind: liveScope.identity?.kind ?? context?.project?.identity_status ?? 'unknown',
            project_fingerprint: liveScope.project_fingerprint ?? context?.project?.project_fingerprint ?? null
          },
          git,
          documentation: context?.documentation ?? null,
          ...revisionFacts(context),
          metrics: { duration_ms: Math.round(performance.now() - started), scope_reused: true }
        };
        return snapshotWithRemote(result, { identity: liveScope.identity, context, git });
      }
      if (typeof this.dependencies.projectSnapshot === 'function') {
        const result = await this.dependencies.projectSnapshot({ cwd });
        return snapshotWithRemote({ ...result, metrics: { duration_ms: Math.round(performance.now() - started), ...(result?.metrics ?? {}) } }, {
          identity: result?.identity,
          context: result?.context,
          git: result?.git
        });
      }
      const planProject = this.dependencies.planProject ?? ((options) => planProjectInitialization({
        ...options, homeDir: homedir(), tempDir: tmpdir()
      }));
      const resolve = this.dependencies.resolveProjectContext ?? resolveProjectContext;
      let context = null;
      try {
        const [plan, git, resolvedContext] = await Promise.all([
          planProject({ cwd }),
          this.gitPreflight({ cwd }),
          resolve({ cwd, dependencies: this.dependencies.projectContextDependencies })
        ]);
        context = resolvedContext;
        const revisions = revisionFacts(context);
        return snapshotWithRemote({
          root: plan?.project_root ?? git?.root ?? cwd,
          eligibility: plan?.eligibility ?? 'unknown',
          identity: {
            kind: plan?.identity?.kind ?? context?.project?.identity_status ?? 'unknown',
            project_fingerprint: plan?.identity?.project_fingerprint ?? context?.project?.project_fingerprint ?? null
          },
          git,
          documentation: context?.documentation ?? null,
          ...revisions,
          metrics: { duration_ms: Math.round(performance.now() - started) }
        }, { identity: plan?.identity, context, git });
      } finally {
        await closeQuietly(context?.wiki?.qmd_client);
      }
    })();
    this.projectSnapshotCache.set(cacheKey, { promise: pending, expires_at: this.now() + this.snapshotTtlMs });
    try {
      return await pending;
    } catch (error) {
      if (this.projectSnapshotCache.get(cacheKey)?.promise === pending) this.projectSnapshotCache.delete(cacheKey);
      throw error;
    }
  }

  async projectContext({ cwd, scope_id } = {}) {
    const scope = await this.assertScope(scope_id, { cwd });
    return publicProjectContext(scope.document_context);
  }

  async gitPreflight({ cwd } = {}) {
    assertCwd(cwd);
    if (typeof this.dependencies.gitPreflight === 'function') return this.dependencies.gitPreflight({ cwd });
    const git = this.dependencies.gitExec ?? ((file, args, options) => execFileAsync(file, args, options));
    try {
      const run = async (args) => (await git('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, windowsHide: true })).stdout;
      const [root, current, upstream, status, sync, conflicts, worktree] = await Promise.all([
        run(['rev-parse', '--show-toplevel']),
        run(['branch', '--show-current']),
        run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => ''),
        run(['status', '--porcelain=v1', '--branch', '--untracked-files=all']),
        run(['rev-list', '--left-right', '--count', 'HEAD...@{u}']).catch(() => ''),
        run(['ls-files', '-u']),
        run(['worktree', 'list', '--porcelain'])
      ]);
      const parsedStatus = parseStatus(status);
      const syncState = parseAheadBehind(sync);
      return {
        status: 'ready', root: root.trim(), branch: { current: current.trim() || null, upstream: upstream.trim() || null },
        dirty: parsedStatus.dirty, files: parsedStatus.files.slice(0, 256),
        sensitive_paths_excluded: parsedStatus.sensitiveCount,
        sync: syncState, conflict: Boolean(String(conflicts).trim()), worktree: String(worktree).trim() ? 'ready' : 'unavailable'
      };
    } catch {
      return { root: cwd, status: 'unavailable', error_code: 'git_preflight_failed' };
    }
  }

  async diffSnapshot({ cwd } = {}) {
    assertCwd(cwd);
    if (typeof this.dependencies.diffSnapshot === 'function') return this.dependencies.diffSnapshot({ cwd });
    const git = this.dependencies.gitExec ?? ((file, args, options) => execFileAsync(file, args, options));
    try {
      const run = async (args) => (await git('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, windowsHide: true })).stdout;
      const [unstagedStat, unstagedNames, stagedStat, stagedNames] = await Promise.all([
        run(['diff', '--stat']), run(['diff', '--name-only']), run(['diff', '--cached', '--stat']), run(['diff', '--cached', '--name-only'])
      ]);
      const unstaged = parseFiles(unstagedNames);
      const staged = parseFiles(stagedNames);
      return {
        status: 'ready', root: cwd,
        unstaged: { files: unstaged.slice(0, 256), stat: sanitizeDiffStat(unstagedStat).slice(0, 16_384) },
        staged: { files: staged.slice(0, 256), stat: sanitizeDiffStat(stagedStat).slice(0, 16_384) },
        sensitive_paths_excluded: (String(unstagedNames).split(/\r?\n/u).filter((x) => x && isSensitivePath(x)).length +
          String(stagedNames).split(/\r?\n/u).filter((x) => x && isSensitivePath(x)).length)
      };
    } catch {
      return { root: cwd, status: 'unavailable', error_code: 'diff_snapshot_failed' };
    }
  }

  openScope(facts = {}) {
    const id = scopeToken();
    const stored = { ...facts, generation: scopeToken(), expires_at: this.now() + this.scopeTtlMs };
    stored.fact_keys = Object.keys(comparableScopeFacts(facts));
    stored.fact_digest = scopeFactDigest(facts);
    this.scopes.set(id, stored);
    return id;
  }

  invalidateScope(scope_id, expectedScope = undefined) {
    if (!scope_id) return Promise.resolve();
    const scope = this.scopes.get(scope_id);
    if (expectedScope !== undefined && scope !== expectedScope) return Promise.resolve();
    this.scopes.delete(scope_id);
    let qmdClose = Promise.resolve();
    if (scope?.qmd_client && typeof scope.qmd_client.close === 'function') {
      qmdClose = Promise.resolve().then(() => scope.qmd_client.close()).catch(() => {});
    }
    for (const key of this.documentCache.keys()) {
      if (key.includes(`\"${scope_id}\"`)) this.documentCache.delete(key);
    }
    for (const key of this.documentReferences.keys()) {
      if (key.startsWith(`${scope_id}:`)) this.documentReferences.delete(key);
    }
    for (const key of this.projectSnapshotCache.keys()) {
      if (key.endsWith(`\u0000${scope_id}`)) this.projectSnapshotCache.delete(key);
    }
    for (const store of [this.sessionState, this.checkpoints, this.sessionRecords]) {
      for (const key of store.keys()) {
        if (key.startsWith(`${scope_id}:`)) store.delete(key);
      }
    }
    return qmdClose;
  }

  async close() {
    const clients = new Set([...this.scopes.values()].map((scope) => scope.qmd_client).filter(Boolean));
    this.scopes.clear();
    this.documentCache.clear();
    this.documentReferences.clear();
    this.sessionState.clear();
    this.checkpoints.clear();
    this.sessionRecords.clear();
    this.projectSnapshotCache.clear();
    await Promise.allSettled([...clients].map((client) => Promise.resolve().then(() => client.close?.())));
  }

  async assertScope(scope_id, { cwd = null, factProvider = undefined, useSnapshotProvider = false } = {}) {
    if (!scope_id) throw new Error('scope_expired');
    const scope = this.scopes.get(scope_id);
    if (!scope || scope.expires_at <= this.now() || (cwd && scope.root !== cwd)) {
      this.invalidateScope(scope_id, scope ?? undefined);
      throw new Error('scope_expired');
    }
    const generation = scope.generation;
    const factDigest = scope.fact_digest;
    const provider = factProvider === undefined
      ? (this.dependencies.scopeFacts ?? (useSnapshotProvider ? scope.snapshot_fact_provider : scope.fact_provider))
      : factProvider;
    if (typeof provider === 'function') {
      let current;
      try {
        current = await provider({ scope_id, cwd: scope.root, scope: { ...scope } });
      } catch {
        this.invalidateScope(scope_id, scope);
        throw new Error('scope_expired');
      }
      if (!current || !scopeFactsMatch(scope, current)) {
        this.invalidateScope(scope_id, scope);
        throw new Error('scope_expired');
      }
    }
    const liveScope = this.scopes.get(scope_id);
    if (liveScope !== scope || liveScope?.generation !== generation || liveScope?.fact_digest !== factDigest) {
      if (liveScope === scope) this.invalidateScope(scope_id, scope);
      throw new Error('scope_expired');
    }
    return scope;
  }

  async documentRead({ cwd, action, request = {}, scope_id = null } = {}) {
    if (!['resolve', 'search', 'get'].includes(action)) throw new TypeError('document read action is invalid');
    for (const key of ['uri', 'collection', 'path', 'root_uri']) {
      if (Object.hasOwn(request, key)) throw new TypeError(`document ${key} must come from verified runtime scope`);
    }
    const scope = action === 'resolve' && !scope_id ? null : await this.assertScope(scope_id, { cwd });
    let runtimeRequest = { ...request };
    if (action === 'get' && Object.hasOwn(runtimeRequest, 'document_ref')) {
      const reference = this.documentReferences.get(`${scope_id}:${runtimeRequest.document_ref}`);
      if (!reference || reference.expires_at <= this.now() || reference.generation !== scope?.generation || reference.fact_digest !== scope?.fact_digest) {
        throw new TypeError('document reference is invalid');
      }
      runtimeRequest = { path: reference.path };
    }
    const cacheKey = JSON.stringify([scope_id, cwd, action, runtimeRequest, scope?.generation ?? null, scope?.fact_digest ?? null]);
    const cached = this.documentCache.get(cacheKey);
    if (cached) return cached.promise ?? cached;
    const execute = this.dependencies.documentExecute ?? ((input) => {
      if (!scope?.document_context) return DocumentRuntime.execute(input);
      const runtime = new DocumentRuntime({ resolveProjectContext: async () => scope.document_context });
      return runtime.execute(input);
    });
    const entry = { promise: null, scope, generation: scope?.generation ?? null, fact_digest: scope?.fact_digest ?? null };
    const operation = Promise.resolve().then(() => execute({ cwd, action, request: runtimeRequest, confirmed: false }));
    entry.promise = (async () => {
      try {
        let result = await operation;
        if (scope) {
          const liveScope = await this.assertScope(scope_id, { cwd });
          if (liveScope !== scope || liveScope.generation !== entry.generation || liveScope.fact_digest !== entry.fact_digest) {
            throw new Error('scope_expired');
          }
        }
        if (result?.status === 'conflict' || result?.status === 'operation_failed') {
          if (this.documentCache.get(cacheKey) === entry) this.documentCache.delete(cacheKey);
        }
        if (action === 'search' && result?.backend === 'local' && Array.isArray(result.documents)) {
          result = {
            ...result,
            documents: result.documents.map((document) => {
              if (typeof document?.path !== 'string') return document;
              const document_ref = scopeToken();
              this.documentReferences.set(`${scope_id}:${document_ref}`, {
                path: document.path, expires_at: scope.expires_at,
                generation: entry.generation, fact_digest: entry.fact_digest
              });
              const { path: _path, ...safeDocument } = document;
              return { ...safeDocument, document_ref };
            })
          };
        }
        if (action === 'get' && result?.backend === 'local' && result.document?.path) {
          const { path: _path, ...safeDocument } = result.document;
          result = { ...result, document: safeDocument };
        }
        return result;
      } catch (error) {
        if (this.documentCache.get(cacheKey) === entry) this.documentCache.delete(cacheKey);
        throw error;
      }
    })();
    this.documentCache.set(cacheKey, entry);
    return entry.promise;
  }

  async documentManifest({ cwd, scope_id } = {}) {
    const scope = await this.assertScope(scope_id, { cwd });
    return {
      status: 'ok',
      project_fingerprint: scope.project_fingerprint ?? null,
      config_revision: scope.config_revision ?? null,
      manifest_revision: scope.manifest_revision ?? scope.revision ?? null,
      manifest_hash: scope.manifest_hash ?? null,
      metrics: { duration_ms: 0 }
    };
  }

  async documentVerify({ cwd, scope_id, logical_id, document_ref } = {}) {
    const result = await this.documentRead({
      cwd,
      action: 'get',
      scope_id,
      request: document_ref ? { document_ref } : { logical_id }
    });
    const document = result?.document ?? null;
    if (!document) return { status: result?.status ?? 'not_found', verified: false };
    const { content: _content, ...metadata } = document;
    return { status: 'ok', verified: true, document: metadata, metrics: { duration_ms: 0 } };
  }

  async contextCollect({ cwd, scope_id, query = '', known_entry_files = [], wiki_root = null, signal } = {}) {
    const scope = await this.assertScope(scope_id, { cwd });
    const runtime_context = scope.document_context ?? null;
    const trustedWikiRoot = trustedWikiRootFrom(runtime_context);
    if (typeof this.dependencies.contextCollect === 'function') {
      return this.dependencies.contextCollect({ cwd, query, runtime_context, known_entry_files, wiki_root: trustedWikiRoot, signal });
    }
    const collect = this.dependencies.collectContext ?? collectContext;
    return collect({ schema_version: 1, cwd, query, wiki_root: trustedWikiRoot, known_entry_files }, {
      signal,
      resolveRuntime: async () => runtime_context
    });
  }

  async verificationRun({ cwd, scope_id, profile, signal, ...input } = {}) {
    if (['command', 'argv', 'env', 'path', 'host'].some((key) => Object.hasOwn(input, key))) {
      throw new TypeError('command argv env path and host overrides are not accepted');
    }
    await this.assertScope(scope_id, { cwd });
    if (!Object.hasOwn(VERIFICATION_PROFILES, profile)) throw new TypeError('verification profile is not allowlisted');
    const run = this.dependencies.runProfile;
    const result = typeof run === 'function'
      ? await run({ ...VERIFICATION_PROFILES[profile], cwd, signal, capabilities: capabilitiesFrom(this.dependencies) })
      : await runVerificationProfile({ profile, cwd, signal, capabilities: capabilitiesFrom(this.dependencies) });
    return {
      status: result?.status ?? 'failed',
      error_code: result?.error_code ?? null,
      exit_code: Number.isInteger(result?.exit_code) ? result.exit_code : null,
      stdout: String(result?.stdout ?? '').slice(0, 16_384),
      stderr: String(result?.stderr ?? '').replace(/\b(?:token|password|secret)=\S+/giu, '$1=[redacted]').slice(0, 4_096),
      truncated: result?.truncated === true,
      duration_ms: Number.isFinite(result?.duration_ms) ? Math.max(0, Math.round(result.duration_ms)) : null
    };
  }

  async sessionPrepare({ cwd, scope_id, request_id, value = {}, signal } = {}) {
    await this.assertScope(scope_id, { cwd });
    if (!boundedId(request_id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('session input is invalid or too large');
    const serialized = statePayload(value);
    const key = `${scope_id}:${request_id}`;
    assertNotAborted(signal);
    this.sessionState.set(key, { value: JSON.parse(serialized), expires_at: this.now() + this.stateTtlMs });
    return { status: 'ok', scope_id, request_id };
  }

  async sessionRecord({ cwd, scope_id, request_id, idempotency_key, references = [], signal } = {}) {
    await this.assertScope(scope_id, { cwd });
    if (!boundedId(request_id) || !boundedId(idempotency_key) || !Array.isArray(references) ||
        references.length > 256 || references.some((reference) => !validSessionReference(reference))) {
      throw new TypeError('session references or record identity are invalid');
    }
    let serialized;
    try {
      serialized = statePayload(references, { references: true });
    } catch {
      throw new TypeError('session references must be bounded logical references only');
    }
    const key = `${scope_id}:${idempotency_key}`;
    const previous = this.sessionRecords.get(key);
    const digest = createHash('sha256').update(serialized, 'utf8').digest('hex');
    assertNotAborted(signal);
    if (previous && previous.expires_at > this.now()) {
      if (previous.digest !== digest) throw new Error('session_conflict');
      return cloneStateValue(previous.result);
    }
    if (previous) this.sessionRecords.delete(key);
    const result = { status: 'ok', scope_id, request_id, idempotency_key, recorded: references.map((ref) => ({
      logical_id: ref.logical_id, status: ref.status ?? null, revision: ref.revision ?? null
    })) };
    this.sessionRecords.set(key, { result: cloneStateValue(result), digest, expires_at: this.now() + this.stateTtlMs });
    return cloneStateValue(result);
  }

  async checkpointPut({ cwd, scope_id, checkpoint_id, value = {}, signal } = {}) {
    await this.assertScope(scope_id, { cwd });
    if (!boundedId(checkpoint_id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('checkpoint is invalid or too large');
    const serialized = statePayload(value);
    assertNotAborted(signal);
    this.checkpoints.set(`${scope_id}:${checkpoint_id}`, { value: JSON.parse(serialized), expires_at: this.now() + this.stateTtlMs });
    return { status: 'ok', scope_id, checkpoint_id };
  }

  async checkpointGet({ cwd, scope_id, checkpoint_id } = {}) {
    await this.assertScope(scope_id, { cwd });
    if (!boundedId(checkpoint_id)) throw new TypeError('checkpoint is invalid');
    const entry = this.checkpoints.get(`${scope_id}:${checkpoint_id}`);
    if (!entry || entry.expires_at <= this.now()) {
      this.checkpoints.delete(`${scope_id}:${checkpoint_id}`);
      return { status: 'not_found', scope_id, checkpoint_id };
    }
    return { status: 'ok', scope_id, checkpoint_id, value: cloneStateValue(entry.value) };
  }

  async commitPreview({ cwd, scope_id } = {}) {
    await this.assertScope(scope_id, { cwd });
    const git = await this.gitPreflight({ cwd });
    const facts = {
      operation: 'commit', root: git.root ?? cwd, branch: git.branch ?? null,
      dirty: git.dirty === true, sync: git.sync ?? null, conflict: git.conflict === true
    };
    return {
      status: 'preview', ...facts, scope_id,
      plan_digest: createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex'),
      mutations: []
    };
  }

  async mergePreview({ cwd, scope_id, target_branch = null } = {}) {
    await this.assertScope(scope_id, { cwd });
    if (typeof target_branch !== 'string' || target_branch.length === 0 || target_branch.length > 255 || /[\0\r\n]/u.test(target_branch)) {
      throw new TypeError('target branch is invalid');
    }
    const git = await this.gitPreflight({ cwd });
    const facts = {
      operation: 'merge', root: git.root ?? cwd, branch: git.branch ?? null,
      target_branch, dirty: git.dirty === true, sync: git.sync ?? null, conflict: git.conflict === true
    };
    return {
      status: 'preview', ...facts, scope_id,
      plan_digest: createHash('sha256').update(JSON.stringify(facts), 'utf8').digest('hex'),
      mutations: []
    };
  }

  async runtimeDoctor() {
    return {
      capabilities: capabilitiesFrom(this.dependencies),
      capability_verification: capabilityVerificationFrom(this.dependencies),
      protocol: { schema_version: 1 },
      metrics: { duration_ms: 0 }
    };
  }
}

export function createHpsRuntime(dependencies = {}) {
  return new HpsRuntime(dependencies);
}
