import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  classifyConfigAtRoot,
  initializeConfigIfMissing,
  readConfigAtRoot
} from './config-manager.js';
import { identifyGitProject } from './project-identity.mjs';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const REQUIRED_DOCS_PATHS = [
  'docs',
  'docs/plans',
  'docs/active',
  'docs/archive',
  'docs/context',
  'docs/.docs-metadata',
  'docs/.docs-metadata/index.json'
];

function isEqualOrWithin(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

async function resolveExistingPath(candidate) {
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
}

async function getGitRoot(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      windowsHide: true
    });
    const root = stdout.trim();
    return root ? realpath(root) : null;
  } catch {
    return null;
  }
}

async function findMarkedProjectRoot(cwd, gitRoot) {
  let current = cwd;
  while (isEqualOrWithin(current, gitRoot)) {
    const marker = path.join(current, '.horspowers-project-root');
    try {
      await access(marker, constants.F_OK);
      return current;
    } catch {
      // Continue only as far as the confirmed Git root.
    }
    if (current === gitRoot) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

async function isWikiNativeProject(root) {
  const markers = [
    path.join(root, 'wiki', 'index.md'),
    path.join(root, 'schema', 'wiki-native-automation.md')
  ];
  try {
    await Promise.all(markers.map((marker) => access(marker, constants.F_OK)));
    return true;
  } catch {
    return false;
  }
}

async function isWritableDirectory(root) {
  try {
    const details = await stat(root);
    if (!details.isDirectory()) return false;
    await access(root, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function docsActionFor(projectRoot) {
  for (const relativePath of REQUIRED_DOCS_PATHS) {
    try {
      await access(path.join(projectRoot, relativePath), constants.F_OK);
    } catch {
      return relativePath === 'docs' ? 'create' : 'repair_missing_structure';
    }
  }
  return 'unchanged';
}

function skippedPlan(reason, projectRoot = null) {
  return {
    eligibility: 'skipped',
    project_root: projectRoot,
    config_action: 'skipped',
    docs_action: 'skipped',
    reason
  };
}

function externalProjectPlan(reason, projectRoot, identity) {
  return {
    eligibility: 'external_project',
    project_root: projectRoot,
    identity,
    config_action: 'external_required',
    docs_action: 'skipped',
    reason
  };
}

/**
 * 生成零写入的项目初始化方案。
 * @param {{cwd: string, homeDir: string, tempDir: string}} options
 * @returns {Promise<Object>}
 */
export async function planProjectInitialization({ cwd, homeDir, tempDir }) {
  const resolvedCwd = await resolveExistingPath(cwd);
  const resolvedHome = await resolveExistingPath(homeDir);
  const resolvedTemp = await resolveExistingPath(tempDir);
  if (!resolvedCwd) {
    if (path.isAbsolute(cwd) && path.isAbsolute(tempDir) && isEqualOrWithin(cwd, tempDir)) {
      return skippedPlan('sensitive_root');
    }
    return skippedPlan('cwd_not_found');
  }

  const filesystemRoot = path.parse(resolvedCwd).root;
  if (resolvedCwd === filesystemRoot || resolvedCwd === resolvedHome ||
      (resolvedTemp && isEqualOrWithin(resolvedCwd, resolvedTemp))) {
    return skippedPlan('sensitive_root', resolvedCwd);
  }
  const gitRoot = await getGitRoot(resolvedCwd);
  if (gitRoot) {
    const gitFilesystemRoot = path.parse(gitRoot).root;
    if (gitRoot === gitFilesystemRoot || gitRoot === resolvedHome ||
        (resolvedTemp && isEqualOrWithin(gitRoot, resolvedTemp))) {
      return skippedPlan('sensitive_root', gitRoot);
    }

    const identity = await identifyGitProject(gitRoot);
    if (identity.kind === 'company') {
      return externalProjectPlan('company_external_config_required', gitRoot, identity);
    }
    if (identity.kind === 'ambiguous_company_remote') {
      return externalProjectPlan('ambiguous_company_remote', gitRoot, identity);
    }
    if (identity.kind === 'none') {
      return externalProjectPlan('unregistered_no_remote', gitRoot, identity);
    }
  }

  if (await isWikiNativeProject(resolvedCwd)) return skippedPlan('wiki_native', resolvedCwd);

  // A marker can select a nested root only after the enclosing repository has
  // been confirmed as an ordinary external Git project above. Without a Git
  // root, it must not create a local configuration or docs as a fallback.
  if (!gitRoot) return skippedPlan('not_a_project');

  // An explicit marker lets an intentionally nested non-Git project opt in
  // without causing the surrounding repository to receive its configuration.
  const markerRoot = await findMarkedProjectRoot(resolvedCwd, gitRoot);
  const projectRoot = markerRoot ?? gitRoot;
  if (!projectRoot) return skippedPlan('not_a_project');

  const projectFilesystemRoot = path.parse(projectRoot).root;
  if (projectRoot === projectFilesystemRoot || projectRoot === resolvedHome ||
      (resolvedTemp && isEqualOrWithin(projectRoot, resolvedTemp))) {
    return skippedPlan('sensitive_root', projectRoot);
  }

  try {
    await access(path.join(projectRoot, '.horspowers-no-auto-init'), constants.F_OK);
    return skippedPlan('opt_out', projectRoot);
  } catch {
    // No explicit opt-out marker.
  }

  if (await isWikiNativeProject(projectRoot)) return skippedPlan('wiki_native', projectRoot);
  if (!await isWritableDirectory(projectRoot)) return skippedPlan('not_writable', projectRoot);

  const configState = classifyConfigAtRoot(projectRoot);
  if (configState === 'missing') {
    return {
      eligibility: 'project',
      project_root: projectRoot,
      config_state: configState,
      config_action: 'create',
      docs_action: 'create',
      reason: null
    };
  }
  if (configState === 'valid') {
    const config = readConfigAtRoot(projectRoot);
    return {
      eligibility: 'project',
      project_root: projectRoot,
      config_state: configState,
      config_action: 'unchanged',
      docs_action: config.documentation.enabled ? await docsActionFor(projectRoot) : 'skipped_disabled',
      reason: null
    };
  }

  const configAction = configState === 'needs_migration'
    ? 'explicit_action_required_migration'
    : configState === 'needs_update'
      ? 'explicit_action_required_update'
      : 'explicit_action_required_invalid';
  return {
    eligibility: 'project',
    project_root: projectRoot,
    config_state: configState,
    config_action: configAction,
    docs_action: 'skipped',
    reason: configState
  };
}

function explicitActionResult(plan) {
  if (plan.config_action.startsWith('explicit_action_required')) {
    return { config: { status: 'explicit_action_required' }, docs: { status: 'skipped' } };
  }
  return null;
}

/**
 * 应用已经验证的方案。任何阶段失败都会保留此前已创建的内容。
 * @param {Object} plan
 * @returns {Promise<{config: Object, docs: Object}>}
 */
export async function applyProjectInitialization(plan) {
  if (plan.eligibility === 'external_project') {
    return { config: { status: 'external_required' }, docs: { status: 'skipped' } };
  }
  if (plan.eligibility !== 'project') {
    return { config: { status: 'skipped' }, docs: { status: 'skipped' } };
  }

  const explicitResult = explicitActionResult(plan);
  if (explicitResult) return explicitResult;

  let configResult = { status: 'unchanged' };
  if (plan.config_action === 'create') {
    const created = await initializeConfigIfMissing(plan.project_root, 'team');
    if (created.status === 'failed') {
      return { config: created, docs: { status: 'skipped' } };
    }
    if (created.status === 'exists' && created.config_state !== 'valid') {
      return { config: { status: 'explicit_action_required' }, docs: { status: 'skipped' } };
    }
    configResult = created.status === 'created' ? { status: 'created' } : { status: 'unchanged' };
  }

  if (plan.docs_action === 'skipped_disabled') {
    return { config: configResult, docs: { status: 'skipped_disabled' } };
  }
  if (plan.docs_action === 'unchanged') {
    return { config: configResult, docs: { status: 'unchanged' } };
  }
  if (plan.docs_action !== 'create' && plan.docs_action !== 'repair_missing_structure') {
    return { config: configResult, docs: { status: 'skipped' } };
  }

  const { ensureDocsInitialized } = require('./docs-core.js');
  const docs = ensureDocsInitialized(plan.project_root);
  return { config: configResult, docs };
}
