#!/usr/bin/env node

/**
 * Horspowers 文档系统迁移脚本
 *
 * 功能：
 * 1. 重命名旧格式 design 文档：YYYY-MM-DD-<topic>-design.md → YYYY-MM-DD-design-<topic>.md
 * 2. 合并旧 decision 文档到 design（如果存在）
 * 3. 更新所有内部链接
 *
 * 使用方式：
 *   node scripts/migrate-docs.js --dry-run
 *
 * 选项：
 *   --dry-run: 仅预览更改，不实际执行
 *
 * DocumentRuntime 尚未定义重命名、合并或批量链接改写协议，因此非
 * dry-run 调用会明确失败，避免此 legacy 入口绕过统一文档边界。
 */

const fs = require('fs');
const path = require('path');

// ANSI 颜色代码
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('');
  log(`\n${title}`, 'bright');
  log('='.repeat(title.length), 'cyan');
}

async function identifyMigrationProject(projectRoot) {
  try {
    const { identifyGitProject } = await import('../lib/project-identity.mjs');
    return await identifyGitProject(projectRoot);
  } catch {
    return { kind: 'none', project_root: projectRoot };
  }
}

function unsupportedMigrationResult(summary = null) {
  return {
    success: false,
    status: 'legacy_document_migration_not_supported_by_runtime',
    no_mutation: true,
    error_code: 'rename_merge_link_update_not_supported_by_document_runtime',
    ...(summary ? { summary } : {})
  };
}

function identityBlockedResult(identity) {
  return {
    success: false,
    status: 'external_document_runtime_not_ready',
    identity,
    no_mutation: true,
    error_code: 'project_identity_blocks_legacy_document_migration'
  };
}

/**
 * 匹配旧格式 design 文档
 * YYYY-MM-DD-<topic>-design.md
 */
const OLD_DESIGN_REGEX = /^(\d{4}-\d{2}-\d{2})-(.+)-design\.md$/;

/**
 * 匹配旧格式 decision 文档
 * YYYY-MM-DD-decision-<title>.md
 */
const OLD_DECISION_REGEX = /^(\d{4}-\d{2}-\d{2})-decision-(.+)\.md$/;

/**
 * 匹配新格式 design 文档
 * YYYY-MM-DD-design-<topic>.md
 */
const NEW_DESIGN_REGEX = /^(\d{4}-\d{2}-\d{2})-design-(.+)\.md$/;

/**
 * 匹配文档内部链接
 * ../plans/YYYY-MM-DD-<topic>-design.md
 * ./YYYY-MM-DD-<topic>-design.md
 */
const DOC_LINK_REGEX = /\[([^\]]+)\]\((\.\.\/[^)]*\/)?(\d{4}-\d{2}-\d{2})-([^-]+)(?:-design)?\.md\)/g;

/**
 * 文档迁移计划
 */
class MigrationPlan {
  constructor() {
    this.renames = []; // { source, target, type }
    this.merges = []; // { decision, design, type }
    this.linkUpdates = []; // { file, oldLink, newLink }
  }

  addRename(source, target, type) {
    this.renames.push({ source, target, type });
  }

  addMerge(decision, design, type) {
    this.merges.push({ decision, design, type });
  }

  addLinkUpdate(file, oldLink, newLink) {
    this.linkUpdates.push({ file, oldLink, newLink });
  }

  summary() {
    return {
      renames: this.renames.length,
      merges: this.merges.length,
      linkUpdates: this.linkUpdates.length,
    };
  }
}

/**
 * 扫描文档目录，查找需要迁移的文档
 */
function scanDocuments(docsRoot = 'docs') {
  const results = {
    oldDesignDocs: [],
    oldDecisionDocs: [],
    allDocs: [],
  };

  const scanDir = (dir) => {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.allDocs.push(fullPath);

        const basename = path.basename(entry.name);

        // 检查旧格式 design 文档
        if (OLD_DESIGN_REGEX.test(basename)) {
          results.oldDesignDocs.push(fullPath);
        }

        // 检查旧格式 decision 文档
        if (OLD_DECISION_REGEX.test(basename)) {
          results.oldDecisionDocs.push(fullPath);
        }
      }
    }
  };

  scanDir(docsRoot);
  return results;
}

/**
 * 分析文档并生成迁移计划
 */
function analyzeMigration(scanResults, docsRoot = 'docs') {
  const plan = new MigrationPlan();

  // 1. 分析旧格式 design 文档重命名
  logSection('📋 分析旧格式 Design 文档');
  for (const docPath of scanResults.oldDesignDocs) {
    const basename = path.basename(docPath);
    const match = basename.match(OLD_DESIGN_REGEX);

    if (match) {
      const [, date, topic] = match;
      const newBasename = `${date}-design-${topic}.md`;
      const newPath = path.join(path.dirname(docPath), newBasename);

      plan.addRename(docPath, newPath, 'design');

      log(`  ✓ ${basename} → ${newBasename}`, 'green');
    }
  }

  // 2. 分析 decision 文档合并
  logSection('📋 分析 Decision 文档合并');
  for (const decisionPath of scanResults.oldDecisionDocs) {
    const basename = path.basename(decisionPath);
    const match = basename.match(OLD_DECISION_REGEX);

    if (match) {
      const [, date, title] = match;
      const designBasename = `${date}-design-${title}.md`;
      const designPath = path.join(path.dirname(decisionPath), designBasename);

      // 检查是否已有对应的 design 文档
      if (fs.existsSync(designPath)) {
        plan.addMerge(decisionPath, designPath, 'decision->design');
        log(`  ⚠ ${basename} 需要合并到 ${designBasename}`, 'yellow');
      } else {
        // 如果没有对应的 design，则重命名 decision 为 design
        plan.addRename(decisionPath, designPath, 'decision->design');
        log(`  → ${basename} 将重命名为 ${designBasename}`, 'blue');
      }
    }
  }

  // 3. 分析需要更新链接的文档
  logSection('📋 分析文档链接更新');
  for (const docPath of scanResults.allDocs) {
    try {
      const content = fs.readFileSync(docPath, 'utf-8');
      const basename = path.basename(docPath);

      // 跳过旧格式文档本身（它们会被重命名）
      if (OLD_DESIGN_REGEX.test(basename) || OLD_DECISION_REGEX.test(basename)) {
        continue;
      }

      let hasUpdates = false;
      let match;
      const linkRegex = new RegExp(DOC_LINK_REGEX);

      while ((match = linkRegex.exec(content)) !== null) {
        const [fullMatch, linkText, relativePath, date, slug, typeSuffix] = match;

        // 构建可能的旧格式路径
        const oldFormatPath = typeSuffix ? `${date}-${slug}-${typeSuffix}.md` : null;
        const newFormatPath = `${date}-design-${slug}.md`;

        // 检查是否是旧格式 design 链接
        if (oldFormatPath && OLD_DESIGN_REGEX.test(oldFormatPath)) {
          const newLink = fullMatch.replace(oldFormatPath, newFormatPath);
          plan.addLinkUpdate(docPath, fullMatch, newLink);
          hasUpdates = true;
        }
      }

      if (hasUpdates) {
        log(`  🔗 ${path.relative(docsRoot, docPath)} 需要更新链接`, 'cyan');
      }
    } catch (error) {
      log(`  ✗ 无法读取 ${docPath}: ${error.message}`, 'red');
    }
  }

  return plan;
}

/**
 * 执行迁移计划的 legacy compatibility surface。
 *
 * 只保留 dry-run 预览。DocumentRuntime 尚不能安全表达重命名、合并与
 * 链接改写，所以实际迁移必须由未来的 runtime 协议实现，而不是在这里
 * 直接操作文件。
 */
function executeMigration(plan, options = {}) {
  const { dryRun = false } = options;
  const summary = plan.summary();
  if (!dryRun) {
    log('  ✗ legacy_document_migration_not_supported_by_runtime', 'red');
    log('  DocumentRuntime 尚不支持重命名、合并或链接改写；未修改任何文档。', 'yellow');
    return unsupportedMigrationResult(summary);
  }

  logSection('🔎 迁移预览');
  log('  ⚠ DRY RUN 模式：不会实际修改文件', 'yellow');
  log('');

  logSection('📝 计划重命名文档');
  for (const rename of plan.renames) {
    log(`  ${rename.source} → ${rename.target}`, 'blue');
  }

  logSection('🔀 计划合并 Decision 到 Design');
  for (const merge of plan.merges) {
    log(`  ${merge.decision} → ${merge.design}`, 'blue');
  }

  logSection('🔗 计划更新文档链接');
  const updatedFiles = new Set();
  for (const update of plan.linkUpdates) {
    if (!updatedFiles.has(update.file)) {
      log(`  ${update.file}`, 'cyan');
      updatedFiles.add(update.file);
    }
    log(`    - ${update.oldLink.slice(0, 50)}... →`, 'blue');
  }

  logSection('📊 迁移总结');
  log(`  重命名文档: ${summary.renames}`, 'green');
  log(`  合并文档: ${summary.merges}`, 'green');
  log(`  更新链接: ${summary.linkUpdates}`, 'green');
  return { success: true, status: 'dry_run', no_mutation: true, summary };
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  const projectRoot = process.cwd();
  const dryRun = args.includes('--dry-run');

  log('═══════════════════════════════════════════════════════════', 'bright');
  log('  Horspowers 文档系统迁移脚本', 'bright');
  log('═══════════════════════════════════════════════════════════', 'bright');

  const identityResult = await identifyMigrationProject(projectRoot);
  const identity = typeof identityResult?.kind === 'string' ? identityResult.kind : 'none';
  if (identity !== 'external') {
    log(`\n✗ external-document-runtime-not-ready (${identity}); local document migration not run`, 'red');
    return identityBlockedResult(identity);
  }

  if (!dryRun) {
    log('\n✗ legacy_document_migration_not_supported_by_runtime', 'red');
    log('  DocumentRuntime 尚不支持重命名、合并或链接改写；未读取或修改本地文档。', 'yellow');
    return unsupportedMigrationResult();
  }

  const docsRoot = path.join(projectRoot, 'docs');

  // 检查文档目录
  if (!fs.existsSync(docsRoot)) {
    log(`\n✗ 错误: 文档目录 ${docsRoot} 不存在`, 'red');
    return {
      success: false,
      status: 'docs_directory_missing',
      no_mutation: true,
      error_code: 'docs_directory_missing'
    };
  }

  // 扫描文档
  logSection('🔍 扫描文档目录');
  const scanResults = scanDocuments(docsRoot);

  log(`  找到文档总数: ${scanResults.allDocs.length}`, 'blue');
  log(`  旧格式 Design: ${scanResults.oldDesignDocs.length}`, 'yellow');
  log(`  旧格式 Decision: ${scanResults.oldDecisionDocs.length}`, 'yellow');

  if (scanResults.oldDesignDocs.length === 0 && scanResults.oldDecisionDocs.length === 0) {
    log('\n✓ 没有需要迁移的文档', 'green');
    return { success: true, status: 'dry_run', no_mutation: true, summary: new MigrationPlan().summary() };
  }

  // 分析迁移计划
  const plan = analyzeMigration(scanResults, docsRoot);

  const result = executeMigration(plan, { dryRun: true });

  log('');
  log('═══════════════════════════════════════════════════════════', 'bright');
  log('  预览完成！实际迁移需等待 DocumentRuntime 支持该协议。', 'green');
  log('═══════════════════════════════════════════════════════════', 'bright');

  return result;
}

// 导出模块函数供测试使用
module.exports = {
  MigrationPlan,
  scanDocuments,
  analyzeMigration,
  executeMigration,
  main,
  unsupportedMigrationResult,
};

// 直接运行脚本
if (require.main === module) {
  main().then((result) => {
    if (result?.success !== true) process.exitCode = 1;
  }).catch((error) => {
    log(`\n✗ 迁移运行失败: ${error.message}`, 'red');
    process.exitCode = 1;
  });
}
