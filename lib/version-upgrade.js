#!/usr/bin/env node
/**
 * Horspowers 版本升级脚本
 * 用于从 4.2.0 以前版本升级到新版本
 *
 * 功能：
 * 1. 检测并处理 document-driven-ai-workflow 旧目录
 * 2. 执行文档目录统一迁移
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

class VersionUpgrader {
    constructor(projectRoot, options = {}) {
        this.projectRoot = projectRoot;
        this.identifyGitProject = options.identifyGitProject || null;
        // All project mutations remain disabled until run() completes its
        // read-only identity preflight.  This also keeps direct helper calls
        // from accidentally writing an external project.
        this.upgradeEligibility = {
            allowed: false,
            status: 'project_identity_not_checked',
            no_mutation: true
        };
        this.currentVersion = this.getCurrentVersion();
        this.ddawPath = path.join(projectRoot, 'document-driven-ai-workflow');
    }

    /**
     * Resolve the project identity before reading any project marker,
     * directory, configuration, or migration plan.  Company and uncertain
     * identities are intentionally fail-closed: the external document
     * protocol must be configured before an upgrade can mutate the project.
     */
    async resolveUpgradeEligibility() {
        let identify = this.identifyGitProject;
        if (!identify) {
            try {
                ({ identifyGitProject: identify } = await import('./project-identity.mjs'));
            } catch {
                return {
                    allowed: false,
                    status: 'project_identity_unavailable',
                    no_mutation: true,
                    identity_kind: 'unknown'
                };
            }
        }

        let identity;
        try {
            identity = await identify(this.projectRoot);
        } catch {
            return {
                allowed: false,
                status: 'project_identity_unavailable',
                no_mutation: true,
                identity_kind: 'unknown'
            };
        }

        switch (identity && identity.kind) {
            case 'external':
                return { allowed: true, status: 'ready', no_mutation: false, identity_kind: 'external' };
            case 'company':
                return {
                    allowed: false,
                    status: 'external_project_upgrade_disabled',
                    no_mutation: true,
                    identity_kind: 'company'
                };
            case 'ambiguous_company_remote':
                return {
                    allowed: false,
                    status: 'ambiguous_project_upgrade_disabled',
                    no_mutation: true,
                    identity_kind: 'ambiguous_company_remote'
                };
            case 'none':
                return {
                    allowed: false,
                    status: 'no_remote_project_upgrade_disabled',
                    no_mutation: true,
                    identity_kind: 'none'
                };
            default:
                return {
                    allowed: false,
                    status: 'project_identity_unavailable',
                    no_mutation: true,
                    identity_kind: 'unknown'
                };
        }
    }

    mutationAllowed() {
        return this.upgradeEligibility && this.upgradeEligibility.allowed === true;
    }

    noMutationResult() {
        return {
            success: false,
            status: this.upgradeEligibility && this.upgradeEligibility.status || 'project_identity_not_checked',
            no_mutation: true
        };
    }

    showUpgradeBlocked(eligibility) {
        console.log('');
        console.log(colors.yellow + '⚠ Horspowers 升级未执行：项目文档边界不允许本地迁移。' + colors.reset);
        console.log('状态: ' + eligibility.status);
        if (eligibility.status === 'external_project_upgrade_disabled') {
            console.log('公司项目必须先完成外置配置注册；升级不会读取或写入版本标记、旧目录或本地文档。');
        } else if (eligibility.status === 'ambiguous_project_upgrade_disabled') {
            console.log('检测到多个不一致的公司 remote；请先消除身份歧义，升级未执行任何项目写入。');
        } else if (eligibility.status === 'no_remote_project_upgrade_disabled') {
            console.log('项目没有可确认的 remote；请先配置受信任的项目身份，升级未执行任何项目写入。');
        } else {
            console.log('项目身份不可用；为避免错误迁移，升级未执行任何项目写入。');
        }
        console.log('');
    }

    /**
     * 获取当前插件版本
     */
    getCurrentVersion() {
        // __dirname 是 lib/ 目录，需要向上两级到项目根目录
        const pluginJsonPath = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
        try {
            const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
            return pluginJson.version;
        } catch (e) {
            return '4.2.0'; // 默认版本
        }
    }

    /**
     * 检查版本文件是否存在（用于检测旧版本安装）
     */
    hasOldVersionMarker() {
        if (!this.mutationAllowed()) return false;
        const markerPath = path.join(this.projectRoot, '.horspowers-version');
        if (fs.existsSync(markerPath)) {
            const version = fs.readFileSync(markerPath, 'utf8').trim();
            // 如果版本小于 4.2.0，需要升级
            return this.compareVersions(version, '4.2.0') < 0;
        }
        return true; // 没有标记文件，假设是旧版本
    }

    /**
     * 比较版本号
     * @returns {number} -1: v1 < v2, 0: v1 == v2, 1: v1 > v2
     */
    compareVersions(v1, v2) {
        const parts1 = v1.split('.').map(Number);
        const parts2 = v2.split('.').map(Number);

        for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
            const p1 = parts1[i] || 0;
            const p2 = parts2[i] || 0;

            if (p1 < p2) return -1;
            if (p1 > p2) return 1;
        }
        return 0;
    }

    /**
     * 检测 document-driven-ai-workflow 目录
     */
    detectDDAWDirectory() {
        if (!this.mutationAllowed()) return null;
        if (!fs.existsSync(this.ddawPath)) {
            return null;
        }

        const stat = fs.statSync(this.ddawPath);
        if (!stat.isDirectory()) {
            return null;
        }

        // 分析目录内容
        const items = fs.readdirSync(this.ddawPath);
        const analysis = {
            path: this.ddawPath,
            itemCount: items.length,
            hasDocs: false,
            hasConfig: false,
            subdirs: []
        };

        items.forEach(item => {
            const itemPath = path.join(this.ddawPath, item);
            const stat = fs.statSync(itemPath);

            if (stat.isDirectory()) {
                analysis.subdirs.push(item);
                if (item === '.docs' || item === 'docs') {
                    analysis.hasDocs = true;
                }
            } else if (item === 'ddaw.config.js' || item === 'ddaw.config.json') {
                analysis.hasConfig = true;
            }
        });

        return analysis;
    }

    /**
     * 询问用户是否移除 DDAW 目录
     */
    async askToRemoveDDAW(ddawInfo) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        return new Promise((resolve) => {
            console.log('');
            console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
            console.log(colors.bright + colors.yellow + '⚠ 检测到旧版本的 document-driven-ai-workflow 目录' + colors.reset);
            console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
            console.log('');
            console.log(colors.bright + '目录位置:' + colors.reset + ' ' + ddawInfo.path);
            console.log(colors.bright + '包含内容:' + colors.reset + ' ' + ddawInfo.itemCount + ' 项');
            console.log('');
            console.log(colors.bright + colors.red + '📌 为什么建议移除？' + colors.reset);
            console.log('   从 horspowers 4.2.0 开始，document-driven-ai-workflow 的功能');
            console.log('   已完全集成到插件内部，不再需要单独安装该工具。');
            console.log('');
            console.log('   新版本使用统一的 ' + colors.bright + 'docs/' + colors.reset + ' 目录结构：');
            console.log('   • docs/plans/      - 设计和计划文档');
            console.log('   • docs/active/     - 活跃任务和 bug 追踪');
            console.log('   • docs/archive/    - 已归档文档');
            console.log('   • docs/context/    - 上下文文档');
            console.log('   • docs/.docs-metadata/ - 元数据和会话状态');
            console.log('');
            console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
            console.log('');

            rl.question(
                colors.bright + '是否移除 document-driven-ai-workflow 目录？' + colors.reset +
                colors.yellow + ' [y/N] ' + colors.reset,
                (answer) => {
                    rl.close();
                    const shouldRemove = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
                    resolve(shouldRemove);
                }
            );
        });
    }

    /**
     * 移除 DDAW 目录
     */
    removeDDAWDirectory() {
        if (!this.mutationAllowed()) return this.noMutationResult();
        try {
            // 先备份到 .trash 目录
            const trashDir = path.join(this.projectRoot, '.horspowers-trash');
            if (!fs.existsSync(trashDir)) {
                fs.mkdirSync(trashDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupName = `document-driven-ai-workflow-${timestamp}`;
            const backupPath = path.join(trashDir, backupName);

            console.log('');
            console.log(colors.blue + '📦 备份旧目录到:' + colors.reset);
            console.log('   ' + backupPath);

            fs.renameSync(this.ddawPath, backupPath);

            console.log(colors.green + '✓ 目录已移除' + colors.reset);
            console.log('');
            console.log(colors.yellow + '💾 提示:' + colors.reset);
            console.log('   备份保存在 ' + colors.bright + '.horspowers-trash/' + colors.reset + ' 目录中');
            console.log('   如果确认一切正常，可以手动删除该备份目录');

            return { success: true, backupPath };
        } catch (error) {
            console.error(colors.red + '✗ 移除目录失败:' + colors.reset, error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * 执行文档迁移
     */
    async migrateDocuments() {
        if (!this.mutationAllowed()) return this.noMutationResult();
        const { UnifiedDocsManager } = require('./docs-core');
        const docsManager = new UnifiedDocsManager(this.projectRoot);

        console.log('');
        console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
        console.log(colors.bright + '📁 文档目录迁移' + colors.reset);
        console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
        console.log('');

        // 检测需要迁移的目录
        const detectedDirs = docsManager.detectDocDirectories();

        if (detectedDirs.length === 0) {
            console.log(colors.yellow + 'ℹ 未检测到需要迁移的文档目录' + colors.reset);
            return { success: true, migrated: false };
        }

        console.log(colors.bright + '检测到的文档目录:' + colors.reset);
        detectedDirs.forEach(dir => {
            console.log(`  • ${dir.path}/ - ${dir.files} 个文件`);
            if (dir.subdirs.length > 0) {
                dir.subdirs.forEach(subdir => {
                    console.log(`    └─ ${subdir}/`);
                });
            }
        });
        console.log('');

        // 生成迁移计划
        const plan = docsManager.generateMigrationPlan();

        if (!plan.needsMigration) {
            console.log(colors.green + '✓ 文档目录已经是统一结构，无需迁移' + colors.reset);
            return { success: true, migrated: false };
        }

        // 显示迁移计划
        console.log(colors.bright + '迁移计划:' + colors.reset);
        plan.sourceDirs.forEach(dirPlan => {
            console.log(`  从 ${colors.bright}${dirPlan.from}${colors.reset}:`);
            dirPlan.actions.forEach(action => {
                console.log(`    → docs/${action.to}/ (${action.fileCount} 个文件)`);
            });
        });
        console.log('');

        // 询问是否继续
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const shouldProceed = await new Promise((resolve) => {
            rl.question(
                colors.bright + '是否执行迁移？' + colors.reset +
                colors.yellow + ' [y/N] ' + colors.reset,
                (answer) => {
                    rl.close();
                    const result = answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
                    resolve(result);
                }
            );
        });

        if (!shouldProceed) {
            console.log(colors.yellow + '✗ 迁移已取消' + colors.reset);
            return { success: true, migrated: false, cancelled: true };
        }

        // 执行迁移
        console.log('');
        console.log(colors.blue + '🚀 执行迁移...' + colors.reset);

        const result = docsManager.executeMigration(plan);

        if (result.success) {
            console.log(colors.green + '✓ 迁移完成!' + colors.reset);
            console.log('');
            console.log(colors.bright + '迁移结果:' + colors.reset);
            result.migrated.forEach(migration => {
                console.log(`  ✓ ${migration.from} → ${migration.to} (${migration.count} 个文件)`);
            });

            if (result.skipped.length > 0) {
                console.log('');
                console.log(colors.yellow + '跳过的文件:' + colors.reset);
                result.skipped.forEach(skip => {
                    console.log(`  - ${skip.file}: ${skip.reason}`);
                });
            }
        } else {
            console.log(colors.red + '✗ 迁移过程中出现错误' + colors.reset);
            result.errors.forEach(err => {
                console.log(`  ${colors.red}✗${colors.reset} ${err.action.from}: ${err.error}`);
            });
        }

        if (result.errors.length > 0) {
            return { success: false, result };
        }

        return { success: true, migrated: true, result };
    }

    /**
     * 更新版本标记
     */
    updateVersionMarker() {
        if (!this.mutationAllowed()) return this.noMutationResult();
        const markerPath = path.join(this.projectRoot, '.horspowers-version');
        fs.writeFileSync(markerPath, this.currentVersion, 'utf8');
        return { success: true };
    }

    /**
     * 显示欢迎信息
     */
    showWelcome() {
        console.log('');
        console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
        console.log(colors.bright + colors.green + '🚀 Horspowers 版本升级' + colors.reset);
        console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
        console.log('');
        console.log('当前版本: ' + colors.bright + this.currentVersion + colors.reset);
        console.log('');
        console.log('此升级助手将帮助你：');
        console.log('  1. 检测并处理旧版本的 document-driven-ai-workflow 目录');
        console.log('  2. 迁移文档到统一的 ' + colors.bright + 'docs/' + colors.reset + ' 目录结构');
        console.log('');
    }

    /**
     * 显示完成信息
     */
    showCompletion(migratedDDAW, migratedDocs) {
        console.log('');
        console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
        console.log(colors.bright + colors.green + '✓ 升级完成!' + colors.reset);
        console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
        console.log('');

        if (migratedDDAW) {
            console.log('✓ 已移除 document-driven-ai-workflow 旧目录');
        }

        if (migratedDocs) {
            console.log('✓ 文档已迁移到统一结构');
        }

        console.log('');
        console.log(colors.bright + '下一步:' + colors.reset);
        console.log('  1. 查看新的文档结构: ' + colors.bright + 'ls docs/' + colors.reset);
        console.log('  2. 使用 ' + colors.bright + '/docs-init' + colors.reset + ' 初始化文档系统');
        console.log('  3. 使用 ' + colors.bright + '/docs-migrate' + colors.reset + ' 进行文档管理');
        console.log('');

        this.updateVersionMarker();
    }

    /**
     * 运行升级流程
     */
    async run(options = {}) {
        // Identity must be resolved before any project-local marker/directory
        // inspection.  Do not replace this with config discovery: company
        // projects intentionally have no local fallback during upgrades.
        this.upgradeEligibility = await this.resolveUpgradeEligibility();
        if (!this.mutationAllowed()) {
            if (!options.quiet) this.showUpgradeBlocked(this.upgradeEligibility);
            return {
                ...this.noMutationResult(),
                needsUpgrade: false,
                migratedDDAW: false,
                migratedDocs: false,
                identity_kind: this.upgradeEligibility.identity_kind
            };
        }

        // 首先检查是否需要升级（仅在版本 < 4.2.0 或没有版本标记时执行）
        if (!this.hasOldVersionMarker()) {
            // 版本已是 4.2.0 或更高，无需升级迁移
            if (!options.quiet) {
                console.log('');
                console.log(colors.green + '✓ 当前版本已是 ' + this.currentVersion + '，无需升级迁移' + colors.reset);
                console.log('');
            }

            // 即使不需要迁移，也更新版本标记（不受 quiet 模式影响）
            this.updateVersionMarker();

            return {
                success: true,
                needsUpgrade: false,
                migratedDDAW: false,
                migratedDocs: false
            };
        }

        this.showWelcome();

        let migratedDDAW = false;
        let migratedDocs = false;
        let hasError = false;

        // 检测 DDAW 目录
        const ddawInfo = this.detectDDAWDirectory();

        if (ddawInfo && !options.skipDDAW) {
            const shouldRemove = await this.askToRemoveDDAW(ddawInfo);
            if (shouldRemove) {
                const result = this.removeDDAWDirectory();
                if (result.success) {
                    migratedDDAW = true;
                } else {
                    hasError = true;
                }
            }
        }

        // 执行文档迁移
        if (!options.skipDocs) {
            const migrationResult = await this.migrateDocuments();
            if (migrationResult.success) {
                if (migrationResult.migrated) {
                    migratedDocs = true;
                }
            } else {
                hasError = true;
            }
        }

        // 只在没有错误时显示完成信息并更新版本标记
        if (!hasError) {
            this.showCompletion(migratedDDAW, migratedDocs);
            // 更新版本标记
            this.updateVersionMarker();
        } else {
            // 显示错误信息
            console.log('');
            console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
            console.log(colors.bright + colors.red + '✗ 升级过程中遇到错误' + colors.reset);
            console.log(colors.cyan + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━' + colors.reset);
            console.log('');
            console.log(colors.yellow + '请检查上述错误信息并修复问题后重试。' + colors.reset);
            console.log('');
            console.log('如需重试升级，请运行: ' + colors.bright + '/upgrade' + colors.reset);
            console.log('或手动运行: ' + colors.bright + './bin/upgrade' + colors.reset);
            console.log('');
        }

        return {
            success: !hasError,
            needsUpgrade: true,
            migratedDDAW,
            migratedDocs
        };
    }
}

// 命令行入口
if (require.main === module) {
    const projectRoot = process.cwd();
    const upgrader = new VersionUpgrader(projectRoot);

    // 解析命令行参数
    const args = process.argv.slice(2);
    const options = {
        skipDDAW: args.includes('--skip-ddaw'),
        skipDocs: args.includes('--skip-docs'),
        quiet: args.includes('--quiet') || args.includes('-q')
    };

    upgrader.run(options).catch(error => {
        console.error(colors.red + '✗ 升级失败:' + colors.reset, error.message);
        process.exit(1);
    });
}

module.exports = { VersionUpgrader };
