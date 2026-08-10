#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RUNTIME_TIMEOUT_MS = 30_000;
const MAX_RUNTIME_OUTPUT_BYTES = 256 * 1024;
const LOGICAL_ID = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const SESSION_REF_TYPES = new Set(['task', 'bug']);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hookOutput(eventName, additionalContext) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext
    }
  };
}

function emit(eventName, additionalContext) {
  process.stdout.write(`${JSON.stringify(hookOutput(eventName, additionalContext))}\n`);
}

function runtimeCliPath() {
  const override = process.env.HORSPOWERS_DOCUMENT_RUNTIME_CLI;
  if (typeof override === 'string' && path.isAbsolute(override)) return override;
  return path.join(pluginRoot, 'lib', 'document-runtime-cli.mjs');
}

function runtimeEnvelope(action, request = {}) {
  return {
    schema_version: 1,
    cwd: process.cwd(),
    action,
    request,
    confirmed: false
  };
}

function parseRuntimeResult(output) {
  const lines = output.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0]);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.status !== 'string' || typeof value.backend !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Invoke the document runtime through stdin only. Runtime stderr is always
 * ignored so a transport error can never enter a Hook additionalContext.
 */
async function callRuntime(action, request = {}) {
  const input = JSON.stringify(runtimeEnvelope(action, request));
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let tooLarge = false;
    let outputBytes = 0;
    const chunks = [];
    let child;
    try {
      child = spawnRuntime(runtimeCliPath());
    } catch {
      resolve(null);
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, RUNTIME_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_RUNTIME_OUTPUT_BYTES) {
        tooLarge = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once('error', () => finish(null));
    child.once('close', (code) => {
      if (timedOut || tooLarge || code !== 0) {
        finish(null);
        return;
      }
      finish(parseRuntimeResult(Buffer.concat(chunks).toString('utf8')));
    });
    child.stdin.once('error', () => {});
    try {
      child.stdin.end(input);
    } catch {
      child.kill('SIGTERM');
    }
  });
}

function spawnRuntime(cli) {
  return spawn(process.execPath, [cli], {
    cwd: process.cwd(),
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore']
  });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function legacyWarning() {
  const home = process.env.HOME;
  if (typeof home !== 'string' || !path.isAbsolute(home)) return '';
  if (!await exists(path.join(home, '.config', 'superpowers', 'skills'))) return '';
  return '<important-reminder>IN YOUR FIRST REPLY AFTER SEEING THIS MESSAGE YOU MUST TELL THE USER:⚠️ **WARNING:** Horspower now uses Claude Code\'s skills system. Custom skills in ~/.config/superpowers/skills are not loaded; move them to ~/.claude/skills.</important-reminder>';
}

function isOlderThanLegacyBaseline(version) {
  const baseline = [4, 2, 0];
  const parts = typeof version === 'string'
    ? version.trim().split('.').map(part => Number(part))
    : [];
  if (parts.length === 0 || parts.some(part => !Number.isSafeInteger(part) || part < 0)) return true;
  for (let index = 0; index < Math.max(parts.length, baseline.length); index += 1) {
    const current = parts[index] ?? 0;
    const required = baseline[index] ?? 0;
    if (current < required) return true;
    if (current > required) return false;
  }
  return false;
}

async function needsLegacyUpgradeCheck(root) {
  const marker = path.join(root, '.horspowers-version');
  try {
    return isOlderThanLegacyBaseline(await readFile(marker, 'utf8'));
  } catch {
    return true;
  }
}

async function legacyUpgradeMessage(resolution) {
  if (resolution?.identity_status !== 'external') return '';
  const root = process.cwd();
  if (!await needsLegacyUpgradeCheck(root)) return '';
  if (await exists(path.join(root, 'document-driven-ai-workflow'))) {
    return '<upgrade-needed>⚠️ 检测到旧 document-driven-ai-workflow 目录。运行 /upgrade 或 node lib/version-upgrade.js 后再清理旧目录。</upgrade-needed>';
  }
  for (const name of ['.docs', 'doc', 'document']) {
    if (await exists(path.join(root, name))) {
      return '<upgrade-needed>⚠️ 检测到旧文档目录。运行 /upgrade 或 node lib/version-upgrade.js 迁移。</upgrade-needed>';
    }
  }
  return '';
}

async function skillContent() {
  try {
    return await readFile(path.join(pluginRoot, 'skills', 'using-horspowers', 'SKILL.md'), 'utf8');
  } catch {
    return 'Error reading using-horspowers skill';
  }
}

function documentationState(resolution) {
  if (resolution?.status === 'ready' && resolution.backend === 'wiki') return 'wiki-ready';
  if (resolution?.status === 'wiki_unavailable') return 'wiki-unavailable';
  if (resolution?.status === 'unregistered_company_project' || resolution?.status === 'unregistered_no_remote') return 'unregistered';
  if (resolution?.status === 'ambiguous_company_remote') return 'ambiguous';
  if (resolution?.identity_status === 'company') return 'wiki-unavailable';
  if (resolution?.status === 'ready' && resolution.backend === 'local') return 'local-ready';
  return 'runtime-unavailable';
}

function startConfigMarker(resolution) {
  const state = documentationState(resolution);
  if (resolution?.identity_status === 'company' ||
      resolution?.identity_status === 'ambiguous_company_remote' ||
      resolution?.identity_status === 'none' ||
      state === 'wiki-ready' || state === 'wiki-unavailable' || state === 'unregistered' || state === 'ambiguous') {
    const source = resolution?.config_source === 'wiki' ? 'wiki' : 'none';
    return `<documentation-runtime status="${state}" config-source=${source}>External documentation state resolved without local initialization.</documentation-runtime>`;
  }
  const markers = {
    missing: '<config-needs-init>true</config-needs-init>',
    needs_migration: '<config-needs-migration>true</config-needs-migration>',
    needs_update: '<config-needs-update>true</config-needs-update>',
    invalid: '<config-invalid>true</config-invalid>',
    valid: '<config-valid>true</config-valid>'
  };
  return markers[resolution?.config_status] ?? '<config-exists>false</config-exists>';
}

async function sessionStart() {
  const resolution = await callRuntime('resolve');
  const [skill, warning, upgrade] = await Promise.all([
    skillContent(),
    legacyWarning(),
    legacyUpgradeMessage(resolution)
  ]);
  const context = [
    '<EXTREMELY_IMPORTANT>',
    'You have horspowers. The compact horspowers:using-horspowers entrypoint follows.',
    skill,
    startConfigMarker(resolution),
    'On the next substantive user message, resolve and call the documented route-request.mjs through safe stdin. SessionStart performs no project initialization, qmd query, or target-Skill routing.',
    upgrade,
    warning,
    '</EXTREMELY_IMPORTANT>'
  ].filter(Boolean).join('\n\n');
  emit('SessionStart', context);
}

function validReference(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, 'document_type') && Object.hasOwn(value, 'logical_id') &&
    SESSION_REF_TYPES.has(value.document_type) && typeof value.logical_id === 'string' && LOGICAL_ID.test(value.logical_id);
}

function suppliedReferences() {
  const raw = process.env.HORSPOWERS_SESSION_DOCUMENT_REFS_JSON;
  if (raw === undefined || raw === '') return { supplied: false, refs: [] };
  try {
    const refs = JSON.parse(raw);
    if (!Array.isArray(refs) || refs.length > 64 || !refs.every(validReference)) return { supplied: true, refs: null };
    const seen = new Set();
    if (refs.some((reference) => seen.has(reference.logical_id) || !seen.add(reference.logical_id))) {
      return { supplied: true, refs: null };
    }
    return { supplied: true, refs };
  } catch {
    return { supplied: true, refs: null };
  }
}

function logicalIdFromLegacyPath(documentType, documentPath) {
  if (typeof documentPath !== 'string' || documentPath.length === 0) return null;
  const basename = path.basename(documentPath);
  if (path.extname(basename).toLocaleLowerCase('en-US') !== '.md') return null;
  let logicalId = basename.slice(0, -3).toLocaleLowerCase('en-US');
  logicalId = logicalId.replace(
    new RegExp(`^(?:\\d{4}-\\d{2}-\\d{2}-)?${documentType}-`, 'u'),
    ''
  );
  return LOGICAL_ID.test(logicalId) ? logicalId : null;
}

function localLegacyReferences() {
  const refs = [];
  const task = logicalIdFromLegacyPath('task', process.env.TASK_DOC);
  const bug = logicalIdFromLegacyPath('bug', process.env.BUG_DOC);
  if (task) refs.push({ document_type: 'task', logical_id: task });
  if (bug) refs.push({ document_type: 'bug', logical_id: bug });
  const seen = new Set();
  return refs.filter((reference) => {
    const key = `${reference.document_type}:${reference.logical_id}`;
    return !seen.has(key) && seen.add(key);
  });
}

function boundedOpaqueSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\0\r\n]/u.test(value)) return 'unknown';
  return value;
}

async function currentBranch() {
  try {
    const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      shell: false,
      windowsHide: true
    });
    const branch = stdout.trim();
    return branch && !/[\0\r\n]/u.test(branch) ? branch : 'detached';
  } catch {
    return 'detached';
  }
}

function endUnavailableContext(resolution) {
  return `${documentationState(resolution)}; documentation not persisted`;
}

async function sessionEnd() {
  const resolution = await callRuntime('resolve');
  if (!resolution || resolution.status !== 'ready') {
    emit('SessionEnd', endUnavailableContext(resolution));
    return;
  }

  const supplied = suppliedReferences();
  if (supplied.refs === null) {
    emit('SessionEnd', 'invalid document references; documentation not persisted');
    return;
  }
  const refs = supplied.supplied
    ? supplied.refs
    : resolution.backend === 'local'
      ? localLegacyReferences()
      : [];
  const outcome = await callRuntime('record-session', {
    session: {
      session_id: boundedOpaqueSessionId(process.env.CLAUDE_SESSION_ID),
      ended_at: new Date().toISOString(),
      branch: await currentBranch()
    },
    document_refs: refs,
    auto_archive_completed: true
  });
  if (!outcome) {
    emit('SessionEnd', 'runtime-unavailable; documentation not persisted');
    return;
  }
  if (outcome.status === 'recorded') {
    emit('SessionEnd', 'documentation recorded through document runtime');
    return;
  }
  if (outcome.status === 'submitted_pending_review') {
    emit('SessionEnd', 'documentation submitted pending review');
    return;
  }
  if (outcome.status === 'partially_submitted') {
    emit('SessionEnd', 'documentation partially submitted; retry required');
    return;
  }
  if (outcome.status === 'confirmation_required') {
    emit('SessionEnd', 'documentation confirmation required; not persisted');
    return;
  }
  emit('SessionEnd', `${documentationState(outcome)}; documentation not persisted`);
}

const action = process.argv[2];
if (action === 'session-start') {
  sessionStart().catch(() => emit('SessionStart', '<documentation-runtime status="runtime-unavailable">External documentation state unavailable.</documentation-runtime>'));
} else if (action === 'session-end') {
  sessionEnd().catch(() => emit('SessionEnd', 'runtime-unavailable; documentation not persisted'));
} else {
  emit('SessionStart', '<documentation-runtime status="runtime-unavailable">External documentation state unavailable.</documentation-runtime>');
}
