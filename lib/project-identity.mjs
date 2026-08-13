import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { URL } from 'node:url';

const execFileAsync = promisify(execFile);
const SCP_STYLE_REMOTE = /^(?:[^@/:\s]+@)?([A-Za-z0-9.-]+):([^\s]*)$/u;

export const COMPANY_AUTHORITIES = new Map([
  ['gitlab.ugnas.com', 'ugnas-gitlab'],
  ['192.168.75.113', 'ugnas-gitlab']
]);

function normalizeHost(host) {
  const normalized = host.toLocaleLowerCase('en-US');
  return normalized.endsWith('.') ? normalized.slice(0, -1) : normalized;
}

function normalizeRepositoryPath(repositoryPath) {
  const parameterStart = repositoryPath.search(/[?#]/u);
  const pathWithoutParameters = parameterStart === -1
    ? repositoryPath
    : repositoryPath.slice(0, parameterStart);
  const trimmed = pathWithoutParameters.replace(/^\/+|\/+$/gu, '');
  if (!trimmed) return null;
  const normalized = trimmed.endsWith('.git') ? trimmed.slice(0, -4) : trimmed;
  return normalized || null;
}

function parseRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) return null;
  const value = remoteUrl.trim();
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      return { host: url.hostname, repositoryPath: url.pathname };
    } catch {
      return null;
    }
  }

  const scpStyle = SCP_STYLE_REMOTE.exec(value);
  if (!scpStyle) return null;
  return { host: scpStyle[1], repositoryPath: scpStyle[2] };
}

function fingerprintFor(canonicalRepository) {
  return `sha256:${createHash('sha256').update(canonicalRepository).digest('hex')}`;
}

function normalizedProjectRoot(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) return null;
  return path.resolve(value);
}

/**
 * Determine whether a project root belongs to one of the explicitly
 * configured local-machine roots.  A path cannot otherwise reveal whether it
 * is a checkout on this machine or a path supplied by a remote workspace.
 * @param {string} projectRoot
 * @param {Array<string>} localProjectRoots
 * @returns {boolean}
 */
export function isProjectPathOnLocalMachine(projectRoot, localProjectRoots = []) {
  const root = normalizedProjectRoot(projectRoot);
  if (!root || !Array.isArray(localProjectRoots)) return false;

  return localProjectRoots
    .map(normalizedProjectRoot)
    .filter(Boolean)
    .some((localRoot) => root === localRoot || root.startsWith(`${localRoot}${path.sep}`));
}

function localProjectRootsForRuntime(dependencies) {
  if (Array.isArray(dependencies.localProjectRoots)) return dependencies.localProjectRoots;

  const environment = dependencies.environment ?? process.env;
  if (Object.hasOwn(environment, 'HORSPOWERS_LOCAL_PROJECT_ROOTS')) {
    const raw = environment.HORSPOWERS_LOCAL_PROJECT_ROOTS;
    return typeof raw === 'string' ? raw.split(path.delimiter).filter(Boolean) : [];
  }

  const runtimePlatform = dependencies.platform ?? platform();
  const runtimeHome = dependencies.homeDir ?? homedir();
  return runtimePlatform === 'darwin' || runtimePlatform === 'win32' ? [runtimeHome] : [];
}

/**
 * Parse a clone URL without relying on partial host matching.
 * @param {string} remoteUrl
 * @returns {{authority: string | null, host: string, normalized_path: string | null, canonical_repository: string | null} | null}
 */
export function normalizeRemoteUrl(remoteUrl) {
  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) return null;

  const host = normalizeHost(parsed.host);
  const normalizedPath = normalizeRepositoryPath(parsed.repositoryPath);
  const authority = COMPANY_AUTHORITIES.get(host) ?? null;
  return {
    authority,
    host,
    normalized_path: normalizedPath,
    canonical_repository: authority && normalizedPath ? `${authority}/${normalizedPath}` : null
  };
}

function companyIdentity(remote, normalized) {
  return {
    kind: 'company',
    remote_name: remote.name,
    canonical_repository: normalized.canonical_repository,
    project_fingerprint: fingerprintFor(normalized.canonical_repository)
  };
}

function ambiguousCompanyIdentity(candidates) {
  return {
    kind: 'ambiguous_company_remote',
    candidates: [...new Set(candidates.map((candidate) => candidate.canonical_repository))].sort()
  };
}

function incompleteCompanyIdentity(candidates) {
  return {
    // Reuse the existing fail-closed identity class so every legacy caller,
    // including the session hooks, takes its established no-local-write path.
    kind: 'ambiguous_company_remote',
    candidates: [],
    reason: 'trusted_company_host_missing_repository_path',
    remote_names: candidates.map((candidate) => candidate.remote.name).sort()
  };
}

/**
 * Classify configured Git remotes into a company identity or a fail-closed state.
 * @param {Array<{name: string, url: string}>} remotes
 * @param {{projectRoot?: string, localProjectRoots?: Array<string>}} options
 * @returns {Object}
 */
export function classifyRepositoryRemotes(remotes, options = {}) {
  const projectRoot = options?.projectRoot ?? options?.project_root;
  const localProjectRoots = options?.localProjectRoots ?? options?.local_project_roots ?? [];
  const validRemotes = Array.isArray(remotes)
    ? remotes.filter((remote) => remote && typeof remote.name === 'string' && typeof remote.url === 'string')
    : [];
  if (validRemotes.length === 0) return { kind: 'none' };

  const normalizedRemotes = validRemotes.map((remote) => ({ remote, normalized: normalizeRemoteUrl(remote.url) }));
  const incompleteCompanyCandidates = normalizedRemotes.filter(({ normalized }) =>
    normalized?.authority && !normalized.canonical_repository
  );
  if (incompleteCompanyCandidates.length > 0) return incompleteCompanyIdentity(incompleteCompanyCandidates);

  const companyCandidates = normalizedRemotes.flatMap(({ remote, normalized }) =>
    normalized?.canonical_repository ? [companyIdentity(remote, normalized)] : []
  );
  if (companyCandidates.length === 0) {
    return { kind: 'external' };
  }

  const originCandidates = companyCandidates.filter((candidate) => candidate.remote_name === 'origin');
  const preferredCandidates = originCandidates.length > 0 ? originCandidates : companyCandidates;
  const canonicalRepositories = new Set(preferredCandidates.map((candidate) => candidate.canonical_repository));
  if (canonicalRepositories.size !== 1) return ambiguousCompanyIdentity(preferredCandidates);

  if (isProjectPathOnLocalMachine(projectRoot, localProjectRoots)) {
    return {
      kind: 'external',
      reason: 'company_remote_local_project',
      project_root: projectRoot
    };
  }

  return preferredCandidates[0];
}

function parseGitRemoteConfig(stdout) {
  return String(stdout)
    .split(/\r?\n/gu)
    .filter(Boolean)
    .flatMap((line) => {
      // Git separates the key and value with horizontal whitespace.  Split
      // once so a value that itself contains whitespace is retained intact.
      const match = /^remote\.([^\s]+)\.url[ \t]+([\s\S]+)$/u.exec(line);
      return match ? [{ name: match[1], url: match[2] }] : [];
    });
}

/**
 * Resolve the Git identity using read-only Git configuration access.
 * @param {string} projectRoot
 * @param {{execFile?: Function, localProjectRoots?: Array<string>, environment?: Object, platform?: string, homeDir?: string}} dependencies
 * @returns {Promise<Object>}
 */
export async function identifyGitProject(projectRoot, dependencies = {}) {
  const execute = dependencies.execFile ?? execFileAsync;
  const localProjectRoots = localProjectRootsForRuntime(dependencies);
  try {
    const { stdout } = await execute(
      'git',
      ['-C', projectRoot, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'],
      { encoding: 'utf8', windowsHide: true, shell: false }
    );
    return {
      ...classifyRepositoryRemotes(parseGitRemoteConfig(stdout), { projectRoot, localProjectRoots }),
      project_root: projectRoot
    };
  } catch {
    return { kind: 'none', project_root: projectRoot };
  }
}
