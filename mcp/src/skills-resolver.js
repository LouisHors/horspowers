import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

// 导入核心技能模块
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// 动态导入 skills-core 模块
import * as skillsCore from '../../lib/skills-core.js';

const {
  extractFrontmatter,
  findSkillsInDir,
  resolveSkillPath,
  stripFrontmatter
} = skillsCore;

/**
 * SkillsResolver - 技能解析器
 * 负责查找、解析和管理技能文档
 */
export class SkillsResolver {
  constructor(options = {}) {
    // 技能目录配置
    this.superpowersDir = options.superpowersDir || path.join(projectRoot, 'skills');
    this.personalDir = options.personalDir || path.join(os.homedir(), '.cursor/skills');
    this.projectDir = options.projectDir || path.join(process.cwd(), '.skills');
    
    // 技能缓存
    this._skillsCache = null;
    this._cacheTimestamp = null;
    this._cacheTTL = 5000; // 5秒缓存
  }

  /**
   * 查找所有技能
   * @returns {Array} 技能列表
   */
  async findAllSkills() {
    const now = Date.now();
    
    // 使用缓存
    if (this._skillsCache && this._cacheTimestamp && (now - this._cacheTimestamp < this._cacheTTL)) {
      return this._skillsCache;
    }

    const allSkills = [];

    // 按优先级查找：项目 > 个人 > superpowers
    if (fs.existsSync(this.projectDir)) {
      const projectSkills = findSkillsInDir(this.projectDir, 'project');
      allSkills.push(...projectSkills);
    }

    if (fs.existsSync(this.personalDir)) {
      const personalSkills = findSkillsInDir(this.personalDir, 'personal');
      allSkills.push(...personalSkills);
    }

    if (fs.existsSync(this.superpowersDir)) {
      const superpowersSkills = findSkillsInDir(this.superpowersDir, 'superpowers');
      allSkills.push(...superpowersSkills);
    }

    // 更新缓存
    this._skillsCache = allSkills;
    this._cacheTimestamp = now;

    return allSkills;
  }

  /**
   * 列出技能（支持过滤）
   * @param {string} source - 技能来源过滤（all/superpowers/personal/project）
   * @returns {Array} 技能列表
   */
  async listSkills(source = 'all') {
    const allSkills = await this.findAllSkills();
    
    if (source === 'all') {
      return allSkills;
    }

    return allSkills.filter(skill => skill.sourceType === source);
  }

  /**
   * 获取技能内容
   * @param {string} skillName - 技能名称（支持 superpowers:xxx 前缀）
   * @returns {Object} 技能内容和元数据
   */
  async getSkill(skillName) {
    // 解析技能路径
    const resolved = resolveSkillPath(
      skillName,
      this.superpowersDir,
      this.personalDir
    );

    if (!resolved) {
      // 尝试项目技能
      if (fs.existsSync(this.projectDir)) {
        const projectPath = path.join(this.projectDir, skillName.replace(/^project:/, ''));
        const projectSkillFile = path.join(projectPath, 'SKILL.md');
        
        if (fs.existsSync(projectSkillFile)) {
          return this._readSkillFile(projectSkillFile, 'project', skillName);
        }
      }
      
      throw new Error(`Skill not found: ${skillName}`);
    }

    return this._readSkillFile(resolved.skillFile, resolved.sourceType, skillName);
  }

  /**
   * 读取技能文件
   * @private
   */
  _readSkillFile(skillFile, sourceType, skillName) {
    const content = fs.readFileSync(skillFile, 'utf8');
    const { name, description } = extractFrontmatter(skillFile);
    const contentWithoutFrontmatter = stripFrontmatter(content);

    return {
      name: name || skillName,
      description,
      sourceType,
      fullContent: content,
      content: contentWithoutFrontmatter,
      path: skillFile
    };
  }

  /**
   * 搜索技能
   * @param {string} query - 搜索关键词
   * @returns {Array} 匹配的技能列表
   */
  async searchSkills(query) {
    const allSkills = await this.findAllSkills();
    const lowerQuery = query.toLowerCase();

    return allSkills.filter(skill => {
      // 在名称和描述中搜索
      return (
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery)
      );
    });
  }

  /**
   * 获取技能的完整路径（用于 resource URI）
   * @param {string} sourceType - 技能来源
   * @param {string} skillName - 技能名称
   * @returns {string} 技能文件路径
   */
  getSkillPath(sourceType, skillName) {
    let baseDir;
    switch (sourceType) {
      case 'project':
        baseDir = this.projectDir;
        break;
      case 'personal':
        baseDir = this.personalDir;
        break;
      case 'superpowers':
      default:
        baseDir = this.superpowersDir;
        break;
    }

    return path.join(baseDir, skillName, 'SKILL.md');
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this._skillsCache = null;
    this._cacheTimestamp = null;
  }
}
