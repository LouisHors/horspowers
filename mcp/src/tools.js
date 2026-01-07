/**
 * Tools Handler - 提供技能操作工具
 * 
 * 工具列表:
 * - list_skills: 列出所有可用技能
 * - get_skill: 获取指定技能的完整内容
 * - search_skills: 按关键词搜索技能
 */

/**
 * 工具定义
 */
export const TOOLS = [
  {
    name: 'list_skills',
    description: '列出所有可用的 Superpowers 技能。可以按来源过滤（superpowers/personal/project）',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: ['all', 'superpowers', 'personal', 'project'],
          description: '技能来源过滤。all=所有技能，superpowers=核心技能库，personal=个人技能，project=项目技能',
          default: 'all'
        }
      }
    }
  },
  {
    name: 'get_skill',
    description: '获取指定技能的完整内容，包括使用说明、流程和最佳实践',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: '技能名称。可以使用简单名称（如 "brainstorming"）或带前缀的名称（如 "superpowers:brainstorming"）'
        }
      },
      required: ['skill_name']
    }
  },
  {
    name: 'search_skills',
    description: '按关键词搜索技能。搜索范围包括技能名称和描述',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词（例如：debug, test, git, review）'
        }
      },
      required: ['query']
    }
  }
];

/**
 * 创建 Tools handlers
 * @param {SkillsResolver} skillsResolver - 技能解析器实例
 * @returns {Object} Tools handlers
 */
export function createToolHandlers(skillsResolver) {
  return {
    /**
     * 列出工具
     */
    async listTools() {
      return { tools: TOOLS };
    },

    /**
     * 调用工具
     * @param {Object} request - 包含 name 和 arguments 的请求对象
     */
    async callTool(request) {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'list_skills':
            return await handleListSkills(skillsResolver, args);

          case 'get_skill':
            return await handleGetSkill(skillsResolver, args);

          case 'search_skills':
            return await handleSearchSkills(skillsResolver, args);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `错误: ${error.message}`
          }],
          isError: true
        };
      }
    }
  };
}

/**
 * 处理 list_skills 工具调用
 */
async function handleListSkills(skillsResolver, args) {
  const source = args.source || 'all';
  const skills = await skillsResolver.listSkills(source);

  // 按来源分组
  const grouped = {
    superpowers: [],
    personal: [],
    project: []
  };

  skills.forEach(skill => {
    grouped[skill.sourceType]?.push(skill);
  });

  // 格式化输出
  let output = `# 可用技能 (共 ${skills.length} 个)\n\n`;

  if (source === 'all' || source === 'superpowers') {
    if (grouped.superpowers.length > 0) {
      output += `## Superpowers 核心技能 (${grouped.superpowers.length})\n\n`;
      grouped.superpowers.forEach(skill => {
        output += `- **${skill.name}**: ${skill.description}\n`;
      });
      output += '\n';
    }
  }

  if (source === 'all' || source === 'personal') {
    if (grouped.personal.length > 0) {
      output += `## 个人技能 (${grouped.personal.length})\n\n`;
      grouped.personal.forEach(skill => {
        output += `- **${skill.name}**: ${skill.description}\n`;
      });
      output += '\n';
    }
  }

  if (source === 'all' || source === 'project') {
    if (grouped.project.length > 0) {
      output += `## 项目技能 (${grouped.project.length})\n\n`;
      grouped.project.forEach(skill => {
        output += `- **${skill.name}**: ${skill.description}\n`;
      });
      output += '\n';
    }
  }

  output += '\n使用 `get_skill` 工具查看技能详情。';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * 处理 get_skill 工具调用
 */
async function handleGetSkill(skillsResolver, args) {
  const { skill_name } = args;

  if (!skill_name) {
    throw new Error('缺少参数: skill_name');
  }

  const skill = await skillsResolver.getSkill(skill_name);

  // 返回技能完整内容（不含 frontmatter）
  let output = `# ${skill.name}\n\n`;
  
  if (skill.description) {
    output += `> ${skill.description}\n\n`;
  }
  
  output += `**来源**: ${skill.sourceType}\n`;
  output += `**路径**: ${skill.path}\n\n`;
  output += '---\n\n';
  output += skill.content;

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * 处理 search_skills 工具调用
 */
async function handleSearchSkills(skillsResolver, args) {
  const { query } = args;

  if (!query) {
    throw new Error('缺少参数: query');
  }

  const results = await skillsResolver.searchSkills(query);

  if (results.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `未找到匹配 "${query}" 的技能。`
      }]
    };
  }

  let output = `# 搜索结果: "${query}" (${results.length} 个匹配)\n\n`;

  results.forEach(skill => {
    output += `## ${skill.name}\n`;
    output += `**来源**: ${skill.sourceType}\n`;
    output += `**描述**: ${skill.description}\n\n`;
  });

  output += '\n使用 `get_skill` 工具查看技能详情。';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}
