import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import { readConfigAtRoot } from './config-manager.js';
import { defaultHostConfigPath, readHostConfig } from './host-config.mjs';
import { identifyGitProject } from './project-identity.mjs';
import { QmdMcpClient } from './qmd-mcp-client.mjs';
import { resolveWikiProjectConfig } from './wiki-config-provider.mjs';

const execFileAsync = promisify(execFile);

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

function emptyContext(status, project) {
  return {
    status,
    project,
    config: { source: 'none', value: null },
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
  });
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
    try {
      const qmdClient = await makeQmdClient(hostResult.config);
      wikiResult = await resolveWiki({
        identity: { ...identity, project_root: root },
        hostConfig: hostResult.config,
        qmdClient
      });
    } catch {
      return emptyContext('wiki_unavailable', project);
    }
    if (wikiResult?.status !== 'ready' || !wikiResult.config) {
      return {
        ...emptyContext(wikiResult?.status ?? 'wiki_unavailable', project),
        ...(wikiResult?.error_code ? { error_code: wikiResult.error_code } : {})
      };
    }

    const config = wikiResult.config;
    return {
      status: 'ready',
      project: projectFor(identity, root, config.project_id, config.project_fingerprint),
      config: { source: 'wiki', value: config },
      documentation: documentationForWiki(config),
      config_revision: wikiResult.config_revision ?? null
    };
  }

  if (identity.kind === 'external') {
    let config;
    try {
      config = readLocalConfig(root);
    } catch {
      return emptyContext('local_config_unavailable', projectFor(identity, root));
    }
    return {
      status: 'ready',
      project: projectFor(identity, root),
      config: { source: 'local', value: config ?? null },
      documentation: documentationForLocal(config)
    };
  }

  return emptyContext('context_unavailable', projectFor(identity, root));
}
