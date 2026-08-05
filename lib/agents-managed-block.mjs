import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const START_MARKER = /<!-- horspowers:managed-routing:start version=(\d+) -->/gu;
const END_MARKER = /<!-- horspowers:managed-routing:end -->/gu;

function markerMatches(content, pattern) {
  pattern.lastIndex = 0;
  return [...content.matchAll(pattern)];
}

function failedPlan(error, targetPath = null) {
  return { status: 'failed', error, target_path: targetPath };
}

function inspectManagedBlock(content, targetPath) {
  const starts = markerMatches(content, START_MARKER);
  const ends = markerMatches(content, END_MARKER);
  if (starts.length === 0 && ends.length === 0) {
    return { status: 'create', range: null };
  }
  if (starts.length !== 1 || ends.length !== 1) {
    return failedPlan('managed routing markers are duplicated or incomplete', targetPath);
  }

  const start = starts[0];
  const end = ends[0];
  const startEnd = start.index + start[0].length;
  if (start.index >= end.index || content.slice(startEnd, end.index).includes('horspowers:managed-routing:start')) {
    return failedPlan('managed routing marker order is invalid', targetPath);
  }
  return {
    status: 'existing',
    version: Number(start[1]),
    range: { start: start.index, end: end.index + end[0].length }
  };
}

function appendManagedBlock(content, template) {
  if (content.length === 0) return template;
  return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${template}`;
}

/**
 * 生成 Codex 全局 AGENTS 托管区块的只读变更计划。
 * @param {{host: string, homeDir: string, templatePath: string}} options
 * @returns {Promise<Object>}
 */
export async function planAgentsBlock({ host, homeDir, templatePath }) {
  if (host !== 'codex') return { status: 'skipped', reason: 'unsupported_host' };

  const targetPath = path.join(homeDir, '.codex', 'AGENTS.md');
  let template;
  try {
    template = await readFile(templatePath, 'utf8');
  } catch (error) {
    return failedPlan(`cannot read managed block template: ${error instanceof Error ? error.message : String(error)}`, targetPath);
  }
  const templateState = inspectManagedBlock(template, templatePath);
  if (templateState.status !== 'existing') {
    return failedPlan('managed block template is invalid', targetPath);
  }

  let content;
  try {
    content = await readFile(targetPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        status: 'create',
        target_path: targetPath,
        next_content: template,
        existing_content: null
      };
    }
    return failedPlan(`cannot read AGENTS.md: ${error instanceof Error ? error.message : String(error)}`, targetPath);
  }

  const blockState = inspectManagedBlock(content, targetPath);
  if (blockState.status === 'failed') return blockState;
  if (blockState.status === 'create') {
    return {
      status: 'create',
      target_path: targetPath,
      next_content: appendManagedBlock(content, template),
      existing_content: content
    };
  }
  if (blockState.version === templateState.version) {
    return { status: 'unchanged', target_path: targetPath };
  }

  return {
    status: 'update',
    target_path: targetPath,
    next_content: `${content.slice(0, blockState.range.start)}${template}${content.slice(blockState.range.end)}`,
    existing_content: content
  };
}

/**
 * 应用已计划的区块变更。更新前创建独立备份，且绝不触及托管区块外的文本。
 * @param {Object} plan
 * @returns {Promise<Object>}
 */
export async function applyAgentsBlock(plan) {
  if (plan.status === 'skipped') return { status: 'skipped' };
  if (plan.status === 'unchanged') return { status: 'unchanged' };
  if (plan.status !== 'create' && plan.status !== 'update') {
    return { status: 'failed', error: plan.error ?? 'invalid managed block plan' };
  }

  try {
    await mkdir(path.dirname(plan.target_path), { recursive: true });
    if (plan.status === 'create') {
      if (plan.existing_content === null) {
        await writeFile(plan.target_path, plan.next_content, { encoding: 'utf8', flag: 'wx' });
        return { status: 'created' };
      }
      const current = await readFile(plan.target_path, 'utf8');
      if (current !== plan.existing_content) return { status: 'failed', error: 'AGENTS.md changed after planning' };
      const temporaryPath = `${plan.target_path}.horspowers-append-${process.pid}-${Date.now()}.tmp`;
      await writeFile(temporaryPath, plan.next_content, { encoding: 'utf8', flag: 'wx' });
      await rename(temporaryPath, plan.target_path);
      return { status: 'created' };
    }

    const current = await readFile(plan.target_path, 'utf8');
    if (current !== plan.existing_content) return { status: 'failed', error: 'AGENTS.md changed after planning' };

    const backupPath = `${plan.target_path}.horspowers-backup-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    await copyFile(plan.target_path, backupPath, constants.COPYFILE_EXCL);
    const temporaryPath = `${plan.target_path}.horspowers-update-${process.pid}-${Date.now()}.tmp`;
    await writeFile(temporaryPath, plan.next_content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, plan.target_path);
    return { status: 'updated', backup_path: backupPath };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
