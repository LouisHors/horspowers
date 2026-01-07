#!/usr/bin/env node

/**
 * Superpowers MCP Server
 * 
 * 将 Superpowers 技能库暴露为 MCP (Model Context Protocol) server
 * 支持 Cursor, VSCode, Windsurf 等 MCP 客户端
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

import { SkillsResolver } from './skills-resolver.js';
import { createResourceHandlers } from './resources.js';
import { createToolHandlers } from './tools.js';
import { createPromptHandlers } from './prompts.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 创建并配置 MCP server
 */
export async function createSuperpowersMcpServer() {
  // 初始化 server
  const server = new Server(
    {
      name: 'superpowers',
      version: '1.0.0'
    },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {}
      }
    }
  );

  // 配置技能目录（支持环境变量覆盖）
  const projectRoot = path.resolve(__dirname, '../..');
  const config = {
    superpowersDir: process.env.SUPERPOWERS_SKILLS_DIR || path.join(projectRoot, 'skills'),
    personalDir: process.env.SUPERPOWERS_PERSONAL_SKILLS || path.join(os.homedir(), '.cursor/skills'),
    projectDir: process.env.SUPERPOWERS_PROJECT_SKILLS || path.join(process.cwd(), '.skills')
  };

  console.error('[Superpowers MCP] 配置信息:');
  console.error(`  核心技能目录: ${config.superpowersDir}`);
  console.error(`  个人技能目录: ${config.personalDir}`);
  console.error(`  项目技能目录: ${config.projectDir}`);

  // 初始化技能解析器
  const skillsResolver = new SkillsResolver(config);

  // 创建 handlers
  const resourceHandlers = createResourceHandlers(skillsResolver);
  const toolHandlers = createToolHandlers(skillsResolver);
  const promptHandlers = createPromptHandlers(skillsResolver);

  // 注册 Resources handlers
  server.setRequestHandler('resources/list', async () => {
    return await resourceHandlers.listResources();
  });

  server.setRequestHandler('resources/read', async (request) => {
    return await resourceHandlers.readResource(request);
  });

  // 注册 Tools handlers
  server.setRequestHandler('tools/list', async () => {
    return await toolHandlers.listTools();
  });

  server.setRequestHandler('tools/call', async (request) => {
    return await toolHandlers.callTool(request);
  });

  // 注册 Prompts handlers
  server.setRequestHandler('prompts/list', async () => {
    return await promptHandlers.listPrompts();
  });

  server.setRequestHandler('prompts/get', async (request) => {
    return await promptHandlers.getPrompt(request);
  });

  console.error('[Superpowers MCP] Server initialized successfully');
  
  return server;
}

/**
 * 启动 MCP server（stdio 传输）
 */
export async function startServer() {
  try {
    console.error('[Superpowers MCP] Starting server...');
    
    const server = await createSuperpowersMcpServer();
    const transport = new StdioServerTransport();
    
    await server.connect(transport);
    
    console.error('[Superpowers MCP] Server running on stdio');
    console.error('[Superpowers MCP] Ready to accept requests');
  } catch (error) {
    console.error('[Superpowers MCP] Fatal error:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件，启动 server
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
