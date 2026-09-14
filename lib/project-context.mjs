import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { classifyConfigAtRoot, readConfigAtRoot } from './config-manager.js';
import { defaultHostConfigPath, readHostConfig, validateHostConfig } from './host-config.mjs';
import { identifyGitProject } from './project-identity.mjs';
import { QmdMcpClient } from './qmd-mcp-client.mjs';
import { resolveWikiProjectConfig } from './wiki-config-provider.mjs';

const execFileAsync = promisify(execFile);

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
}

function insideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function resolveTrustedPersonalWikiRoot({ hostConfig, dependencies = {} } = {}) {
  const validatedHost = validateHostConfig(hostConfig);
  if (!validatedHost.ok) return null;
  const trustedHostConfig = validatedHost.config;
  const configuredRoot = trustedHostConfig.wiki.local_root;
  if (typeof configuredRoot !== 'string') return null;
  const canonicalize = dependencies.realpath ?? realpath;
  const inspect = dependencies.stat ?? stat;
  const checkAccess = dependencies.access ?? access;
  try {
    const canonicalRoot = await canonicalize(configuredRoot);
    const rootStat = await inspect(canonicalRoot);
    if (!rootStat.isDirectory()) return null;
    const indexPath = path.join(canonicalRoot, 'wiki', 'index.md');
    const canonicalIndex = await canonicalize(indexPath);
    if (!insideRoot(canonicalIndex, canonicalRoot)) return null;
    const indexStat = await inspect(canonicalIndex);
    if (!indexStat.isFile()) return null;
    await checkAccess(canonicalIndex, constants.R_OK);
    return {
      wiki_root: canonicalRoot,
      wiki_root_trusted: true,
      wiki_root_provenance: {
        source: 'validated_host_config',
        field: 'wiki.local_root',
        collection: trustedHostConfig.wiki.collection,
        canonical: true
      }
    };
  } catch {
    return null;
  }
}

async function resolveGitRoot(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false
    });
    const root = stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

function disabledDocumentation() {
  return { backend: 'disabled', enabled: false, auto_submit: false };
}

function configStatusForUnavailableContext(status) {
  if (status === 'unregistered_company_project' || status === 'unregistered_no_remote') return 'unregistered';
  if (status === 'ambiguous_company_remote') return 'ambiguous';
  return 'unavailable';
}

function emptyContext(status, project, configStatus = configStatusForUnavailableContext(status)) {
  return {
    status,
    identity_status: project?.identity_status ?? 'none',
    project,
    config: { source: 'none', value: null },
    config_status: configStatus,
    documentation: disabledDocumentation()
  };
}

function projectFor(identity, root, projectId = null, fingerprint = null) {
  const kind = identity?.kind === 'company'
    ? 'company'
    : identity?.kind === 'external'
      ? 'local'
      : identity?.kind ?? 'none';
  return {
    kind,
    root,
    identity_status: identity?.kind ?? 'none',
    project_id: projectId,
    project_fingerprint: fingerprint
  };
}

function documentationForLocal(config) {
  if (config?.documentation?.enabled !== true) return disabledDocumentation();
  return { backend: 'local', enabled: true, auto_submit: false };
}

function documentationForWiki(config) {
  if (config?.documentation?.enabled !== true) return disabledDocumentation();
  return {
    backend: 'wiki',
    enabled: true,
    auto_submit: config.documentation.submission.auto_submit === true
  };
}

function injected(dependencies, primary, alias, fallback) {
  return dependencies?.[primary] ?? dependencies?.[alias] ?? fallback;
}

function qmdClientFor(hostConfig) {
  return new QmdMcpClient({
    collection: hostConfig.wiki.collection,
    transport: hostConfig.wiki.transport
  }, { persistent: true });
}

async function closeQmdQuietly(qmdClient) {
  try {
    await qmdClient?.close?.();
  } catch {
    // Cleanup is best effort and must never replace the context outcome.
  }
}

/**
 * Resolve the read-only configuration/documentation context for one project.
 * Dependencies are injectable so callers and tests never need a real host
 * configuration or qmd transport.
 * @param {{cwd: string, homeDir?: string, dependencies?: Object, identity?: Object, projectRoot?: string}} options
 * @returns {Promise<Object>}
 */
export async function resolveProjectContext({
  cwd,
  homeDir = homedir(),
  dependencies = {},
  identity: providedIdentity,
  projectRoot: providedRoot
} = {}) {
  const getRoot = injected(dependencies, 'resolveProjectRoot', 'getGitRoot', resolveGitRoot);
  const identify = injected(dependencies, 'identifyGitProject', 'identifyProject', identifyGitProject);
  const readHost = injected(dependencies, 'readHostConfig', 'readHost', readHostConfig);
  const hostPathFor = injected(dependencies, 'defaultHostConfigPath', 'hostConfigPath', defaultHostConfigPath);
  const makeQmdClient = injected(dependencies, 'createQmdClient', 'qmdClientFor', qmdClientFor);
  const resolveWiki = injected(dependencies, 'resolveWikiProjectConfig', 'resolveWikiConfig', resolveWikiProjectConfig);
  const readLocalConfig = injected(dependencies, 'readConfigAtRoot', 'readLocalConfig', readConfigAtRoot);
  const classifyLocalConfig = injected(dependencies, 'classifyConfigAtRoot', 'classifyLocalConfig', classifyConfigAtRoot);

  let root;
  try {
    root = providedRoot ?? await getRoot(cwd);
  } catch {
    return emptyContext('context_unavailable', projectFor(null, null));
  }
  if (typeof root !== 'string' || !root) return emptyContext('not_a_project', projectFor(null, null));

  let identity;
  try {
    identity = providedIdentity ?? await identify(root);
  } catch {
    return emptyContext('context_unavailable', projectFor(null, root));
  }
  if (!identity || typeof identity.kind !== 'string') {
    return emptyContext('context_unavailable', projectFor(null, root));
  }

  if (identity.kind === 'none') {
    return emptyContext('unregistered_no_remote', projectFor(identity, root));
  }
  if (identity.kind === 'ambiguous_company_remote') {
    return emptyContext('ambiguous_company_remote', projectFor(identity, root));
  }

  if (identity.kind === 'company') {
    const project = projectFor(identity, root, null, identity.project_fingerprint ?? null);
    let hostResult;
    try {
      hostResult = await readHost(hostPathFor(homeDir));
    } catch {
      return emptyContext('wiki_unavailable', project);
    }
    if (!hostResult?.ok || !hostResult.config) {
      return {
        ...emptyContext('wiki_unavailable', project),
        error_code: hostResult?.error_code ?? 'host_config_unavailable'
      };
    }

    let wikiResult;
    let qmdClient;
    try {
      qmdClient = await makeQmdClient(hostResult.config);
      wikiResult = await resolveWiki({
        identity: { ...identity, project_root: root },
        hostConfig: hostResult.config,
        qmdClient
      });
    } catch {
      await closeQmdQuietly(qmdClient);
      return emptyContext('wiki_unavailable', project);
    }
    if (wikiResult?.status !== 'ready' || !wikiResult.config) {
      await closeQmdQuietly(qmdClient);
      return {
        ...emptyContext(wikiResult?.status ?? 'wiki_unavailable', project),
        ...(wikiResult?.error_code ? { error_code: wikiResult.error_code } : {})
      };
    }

    if (typeof wikiResult.config_uri !== 'string' || !qmdClient || typeof qmdClient !== 'object') {
      await closeQmdQuietly(qmdClient);
      return {
        ...emptyContext('wiki_unavailable', project),
        error_code: 'wiki_runtime_metadata_unavailable'
      };
    }

    const config = wikiResult.config;
    const manifest = wikiResult.manifest ?? null;
    return {
      status: 'ready',
      identity_status: 'company',
      project: projectFor(identity, root, config.project_id, config.project_fingerprint),
      config: { source: 'wiki', value: config },
      config_status: 'valid',
      documentation: documentationForWiki(config),
      config_revision: wikiResult.config_revision ?? null,
      config_hash: digest(config),
      manifest_hash: digest(manifest),
      host_config_digest: digest(hostResult.config),
      transport_digest: digest(hostResult.config?.wiki?.transport ?? null),
      // These are internal, already-validated transport values. They stay in
      // the context object so DocumentRuntime can construct the Wiki backend
      // without re-resolving configuration or exposing them through its CLI.
      wiki: {
        config_uri: wikiResult.config_uri,
        host_config: hostResult.config,
        qmd_client: qmdClient,
        manifest,
        manifest_hash: digest(manifest),
        host_config_digest: digest(hostResult.config),
        transport_digest: digest(hostResult.config?.wiki?.transport ?? null)
      }
    };
  }

  if (identity.kind === 'external') {
    let config;
    let configStatus;
    try {
      config = readLocalConfig(root);
      configStatus = classifyLocalConfig(root);
    } catch {
      return emptyContext('local_config_unavailable', projectFor(identity, root), 'invalid');
    }
    if (!['valid', 'missing', 'needs_migration', 'needs_update', 'invalid'].includes(configStatus)) {
      configStatus = config ? 'invalid' : 'missing';
    }
    const documentation = documentationForLocal(config);
    let trustedWiki = null;
    if (documentation.enabled === true) {
      try {
        const hostResult = await readHost(hostPathFor(homeDir));
        if (hostResult?.ok && hostResult.config) {
          const resolveTrustedWiki = dependencies.resolveTrustedWikiRoot ?? resolveTrustedPersonalWikiRoot;
          trustedWiki = await resolveTrustedWiki({ hostConfig: hostResult.config, dependencies });
        }
      } catch {
        trustedWiki = null;
      }
    }
    return {
      status: 'ready',
      identity_status: 'external',
      project: projectFor(identity, root),
      config: { source: 'local', value: config ?? null },
      config_status: configStatus,
      documentation,
      config_hash: digest(config ?? null),
      ...(trustedWiki?.wiki_root_trusted === true ? trustedWiki : {})
    };
  }

  return emptyContext('context_unavailable', projectFor(identity, root));
}
