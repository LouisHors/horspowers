import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
 * @returns {Object}
 */
export function classifyRepositoryRemotes(remotes) {
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

  return preferredCandidates[0];
}

function parseGitRemoteConfig(stdout) {
  return String(stdout)
    .split(/\r?\n/gu)
    .filter(Boolean)
    .flatMap((line) => {
      const separatorIndex = line.indexOf('\t');
      const key = separatorIndex === -1 ? null : line.slice(0, separatorIndex);
      const url = separatorIndex === -1 ? null : line.slice(separatorIndex + 1);
      const keyPrefix = 'remote.';
      const keySuffix = '.url';
      if (!key || !key.startsWith(keyPrefix) || !key.endsWith(keySuffix)) return [];

      const name = key.slice(keyPrefix.length, -keySuffix.length);
      return name ? [{ name, url }] : [];
    });
}

/**
 * Resolve the Git identity using read-only Git configuration access.
 * @param {string} projectRoot
 * @param {{execFile?: Function}} dependencies
 * @returns {Promise<Object>}
 */
export async function identifyGitProject(projectRoot, dependencies = {}) {
  const execute = dependencies.execFile ?? execFileAsync;
  try {
    const { stdout } = await execute(
      'git',
      ['-C', projectRoot, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'],
      { encoding: 'utf8', windowsHide: true, shell: false }
    );
    return { ...classifyRepositoryRemotes(parseGitRemoteConfig(stdout)), project_root: projectRoot };
  } catch {
    return { kind: 'none', project_root: projectRoot };
  }
}
