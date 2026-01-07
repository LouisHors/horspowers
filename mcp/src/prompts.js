/**
 * Prompts Handler - 提供预定义的提示模板
 * 
 * Prompts 是预定义的消息模板，可以快速启动常用工作流
 * 支持的 prompts:
 * - session_start: 会话启动（注入 using-superpowers）
 * - brainstorm: 头脑风暴流程
 * - debug: 系统化调试
 * - tdd: 测试驱动开发
 * - code_review: 请求代码审查
 * - write_plan: 编写实施计划
 */

/**
 * Prompt 定义
 */
export const PROMPTS = [
  {
    name: 'session_start',
    description: '会话启动提示 - 自动注入 using-superpowers 技能，介绍如何使用 Superpowers',
    arguments: []
  },
  {
    name: 'brainstorm',
    description: '开始头脑风暴流程 - 通过问答探索需求，形成完整设计',
    arguments: [
      {
        name: 'idea',
        description: '要讨论的想法或功能描述（可选）',
        required: false
      }
    ]
  },
  {
    name: 'debug',
    description: '系统化调试流程 - 4 阶段调试方法：理解、假设、验证、修复',
    arguments: [
      {
        name: 'issue',
        description: '问题描述（可选）',
        required: false
      }
    ]
  },
  {
    name: 'tdd',
    description: '测试驱动开发流程 - RED-GREEN-REFACTOR 循环',
    arguments: []
  },
  {
    name: 'code_review',
    description: '请求代码审查 - 使用预审查清单确保代码质量',
    arguments: []
  },
  {
    name: 'write_plan',
    description: '编写实施计划 - 将任务分解为 2-5 分钟的小步骤',
    arguments: []
  }
];

/**
 * 创建 Prompts handlers
 * @param {SkillsResolver} skillsResolver - 技能解析器实例
 * @returns {Object} Prompts handlers
 */
export function createPromptHandlers(skillsResolver) {
  return {
    /**
     * 列出所有 prompts
     */
    async listPrompts() {
      return { prompts: PROMPTS };
    },

    /**
     * 获取 prompt 内容
     * @param {Object} request - 包含 name 和 arguments 的请求对象
     */
    async getPrompt(request) {
      const { name, arguments: args = {} } = request.params;

      try {
        switch (name) {
          case 'session_start':
            return await buildSessionStartPrompt(skillsResolver);

          case 'brainstorm':
            return await buildBrainstormPrompt(skillsResolver, args);

          case 'debug':
            return await buildDebugPrompt(skillsResolver, args);

          case 'tdd':
            return await buildTddPrompt(skillsResolver);

          case 'code_review':
            return await buildCodeReviewPrompt(skillsResolver);

          case 'write_plan':
            return await buildWritePlanPrompt(skillsResolver);

          default:
            throw new Error(`Unknown prompt: ${name}`);
        }
      } catch (error) {
        console.error('Error getting prompt:', error);
        throw new Error(`Failed to get prompt: ${error.message}`);
      }
    }
  };
}

/**
 * 构建会话启动 prompt
 */
async function buildSessionStartPrompt(skillsResolver) {
  const skill = await skillsResolver.getSkill('using-superpowers');

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `<EXTREMELY_IMPORTANT>
You have superpowers.

**Below is the full content of your 'superpowers:using-superpowers' skill - your introduction to using skills. For all other skills, use MCP tools to load them:**

${skill.content}

</EXTREMELY_IMPORTANT>`
        }
      }
    ]
  };
}

/**
 * 构建头脑风暴 prompt
 */
async function buildBrainstormPrompt(skillsResolver, args) {
  const skill = await skillsResolver.getSkill('brainstorming');
  const { idea } = args;

  let userMessage = '我想开始头脑风暴流程。';
  if (idea) {
    userMessage = `我想讨论这个想法：${idea}`;
  }

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `${userMessage}

请使用 brainstorming 技能引导我完成这个过程。

${skill.content}`
        }
      }
    ]
  };
}

/**
 * 构建调试 prompt
 */
async function buildDebugPrompt(skillsResolver, args) {
  const skill = await skillsResolver.getSkill('systematic-debugging');
  const { issue } = args;

  let userMessage = '我需要调试一个问题。';
  if (issue) {
    userMessage = `我遇到了这个问题：${issue}`;
  }

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `${userMessage}

请使用系统化调试流程帮我解决。

${skill.content}`
        }
      }
    ]
  };
}

/**
 * 构建 TDD prompt
 */
async function buildTddPrompt(skillsResolver) {
  const skill = await skillsResolver.getSkill('test-driven-development');

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `我想使用测试驱动开发（TDD）流程。

请引导我完成 RED-GREEN-REFACTOR 循环。

${skill.content}`
        }
      }
    ]
  };
}

/**
 * 构建代码审查 prompt
 */
async function buildCodeReviewPrompt(skillsResolver) {
  const skill = await skillsResolver.getSkill('requesting-code-review');

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `我想请求代码审查。

请帮我完成预审查清单并准备代码审查。

${skill.content}`
        }
      }
    ]
  };
}

/**
 * 构建编写计划 prompt
 */
async function buildWritePlanPrompt(skillsResolver) {
  const skill = await skillsResolver.getSkill('writing-plans');

  return {
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `我需要为接下来的工作编写详细的实施计划。

请帮我将任务分解为小步骤。

${skill.content}`
        }
      }
    ]
  };
}
