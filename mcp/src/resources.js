/**
 * Resources Handler - 将技能文档暴露为 MCP Resources
 * 
 * Resources 允许客户端（如 Cursor）浏览和读取技能内容
 * URI 格式: skill://<sourceType>/<skillName>
 * 例如: skill://superpowers/brainstorming
 */

/**
 * 解析技能 URI
 * @param {string} uri - 技能 URI
 * @returns {Object} 解析后的对象 {sourceType, skillName}
 */
function parseSkillUri(uri) {
  const match = uri.match(/^skill:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid skill URI: ${uri}`);
  }

  return {
    sourceType: match[1],
    skillName: match[2]
  };
}

/**
 * 格式化技能为 URI
 * @param {string} sourceType - 技能来源
 * @param {string} skillName - 技能名称
 * @returns {string} URI
 */
function formatSkillUri(sourceType, skillName) {
  return `skill://${sourceType}/${skillName}`;
}

/**
 * 创建 Resources handlers
 * @param {SkillsResolver} skillsResolver - 技能解析器实例
 * @returns {Object} Resources handlers
 */
export function createResourceHandlers(skillsResolver) {
  return {
    /**
     * 列出所有技能作为 resources
     */
    async listResources() {
      try {
        const skills = await skillsResolver.findAllSkills();
        
        return {
          resources: skills.map(skill => ({
            uri: formatSkillUri(skill.sourceType, skill.name),
            name: skill.name,
            description: skill.description || 'No description available',
            mimeType: 'text/markdown'
          }))
        };
      } catch (error) {
        console.error('Error listing resources:', error);
        return { resources: [] };
      }
    },

    /**
     * 读取技能内容
     * @param {Object} request - 包含 uri 的请求对象
     */
    async readResource(request) {
      try {
        const { uri } = request.params;
        const { sourceType, skillName } = parseSkillUri(uri);
        
        // 构造完整的技能名称（如果需要前缀）
        let fullSkillName = skillName;
        if (sourceType === 'superpowers') {
          fullSkillName = `superpowers:${skillName}`;
        } else if (sourceType === 'project') {
          fullSkillName = `project:${skillName}`;
        }

        const skill = await skillsResolver.getSkill(fullSkillName);

        return {
          contents: [{
            uri: uri,
            mimeType: 'text/markdown',
            text: skill.fullContent
          }]
        };
      } catch (error) {
        console.error('Error reading resource:', error);
        throw new Error(`Failed to read skill: ${error.message}`);
      }
    }
  };
}
