#!/usr/bin/env node

/**
 * 基础测试脚本 - 验证 MCP server 核心功能
 * 不需要实际的 MCP 客户端，直接测试各个模块
 */

import { SkillsResolver } from './src/skills-resolver.js';
import { createResourceHandlers } from './src/resources.js';
import { createToolHandlers } from './src/tools.js';
import { createPromptHandlers } from './src/prompts.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 测试结果
const results = {
  passed: 0,
  failed: 0,
  tests: []
};

function test(name, fn) {
  return async () => {
    try {
      await fn();
      results.passed++;
      results.tests.push({ name, status: 'PASS' });
      console.log(`✓ ${name}`);
    } catch (error) {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', error: error.message });
      console.error(`✗ ${name}`);
      console.error(`  错误: ${error.message}`);
    }
  };
}

async function runTests() {
  console.log('🧪 开始测试 Superpowers MCP Server\n');

  // 初始化
  const projectRoot = path.resolve(__dirname, '..');
  const skillsResolver = new SkillsResolver({
    superpowersDir: path.join(projectRoot, 'skills'),
    personalDir: '/tmp/test-personal-skills',
    projectDir: '/tmp/test-project-skills'
  });

  const resourceHandlers = createResourceHandlers(skillsResolver);
  const toolHandlers = createToolHandlers(skillsResolver);
  const promptHandlers = createPromptHandlers(skillsResolver);

  // ===== SkillsResolver 测试 =====
  console.log('📦 SkillsResolver 测试:');

  await test('查找所有技能', async () => {
    const skills = await skillsResolver.findAllSkills();
    if (skills.length === 0) throw new Error('没有找到任何技能');
    console.log(`   找到 ${skills.length} 个技能`);
  })();

  await test('列出 superpowers 技能', async () => {
    const skills = await skillsResolver.listSkills('superpowers');
    if (skills.length === 0) throw new Error('没有找到 superpowers 技能');
    console.log(`   找到 ${skills.length} 个 superpowers 技能`);
  })();

  await test('获取 brainstorming 技能', async () => {
    const skill = await skillsResolver.getSkill('brainstorming');
    if (!skill.name) throw new Error('技能名称为空');
    if (!skill.content) throw new Error('技能内容为空');
    console.log(`   技能名称: ${skill.name}`);
    console.log(`   内容长度: ${skill.content.length} 字符`);
  })();

  await test('搜索包含 "debug" 的技能', async () => {
    const results = await skillsResolver.searchSkills('debug');
    if (results.length === 0) throw new Error('没有找到匹配的技能');
    console.log(`   找到 ${results.length} 个匹配技能`);
  })();

  await test('获取不存在的技能应该抛出错误', async () => {
    try {
      await skillsResolver.getSkill('non-existent-skill-12345');
      throw new Error('应该抛出错误但没有');
    } catch (error) {
      if (!error.message.includes('not found')) {
        throw new Error(`错误消息不正确: ${error.message}`);
      }
    }
  })();

  // ===== Resources Handler 测试 =====
  console.log('\n🗂️  Resources Handler 测试:');

  await test('列出所有 resources', async () => {
    const result = await resourceHandlers.listResources();
    if (!result.resources || result.resources.length === 0) {
      throw new Error('没有找到 resources');
    }
    console.log(`   找到 ${result.resources.length} 个 resources`);
  })();

  await test('读取 resource (brainstorming)', async () => {
    const result = await resourceHandlers.readResource({
      params: { uri: 'skill://superpowers/brainstorming' }
    });
    if (!result.contents || result.contents.length === 0) {
      throw new Error('Resource 内容为空');
    }
    console.log(`   内容长度: ${result.contents[0].text.length} 字符`);
  })();

  // ===== Tools Handler 测试 =====
  console.log('\n🛠️  Tools Handler 测试:');

  await test('列出所有 tools', async () => {
    const result = await toolHandlers.listTools();
    if (!result.tools || result.tools.length === 0) {
      throw new Error('没有找到 tools');
    }
    console.log(`   找到 ${result.tools.length} 个 tools`);
  })();

  await test('调用 list_skills tool', async () => {
    const result = await toolHandlers.callTool({
      params: { name: 'list_skills', arguments: { source: 'all' } }
    });
    if (!result.content || result.content.length === 0) {
      throw new Error('Tool 返回内容为空');
    }
    const text = result.content[0].text;
    if (!text.includes('可用技能')) {
      throw new Error('输出格式不正确');
    }
    console.log(`   输出长度: ${text.length} 字符`);
  })();

  await test('调用 get_skill tool', async () => {
    const result = await toolHandlers.callTool({
      params: { name: 'get_skill', arguments: { skill_name: 'brainstorming' } }
    });
    if (!result.content || result.content.length === 0) {
      throw new Error('Tool 返回内容为空');
    }
    const text = result.content[0].text;
    if (!text.includes('brainstorming')) {
      throw new Error('技能内容不正确');
    }
    console.log(`   输出长度: ${text.length} 字符`);
  })();

  await test('调用 search_skills tool', async () => {
    const result = await toolHandlers.callTool({
      params: { name: 'search_skills', arguments: { query: 'test' } }
    });
    if (!result.content || result.content.length === 0) {
      throw new Error('Tool 返回内容为空');
    }
    console.log(`   搜索结果长度: ${result.content[0].text.length} 字符`);
  })();

  // ===== Prompts Handler 测试 =====
  console.log('\n🎯 Prompts Handler 测试:');

  await test('列出所有 prompts', async () => {
    const result = await promptHandlers.listPrompts();
    if (!result.prompts || result.prompts.length === 0) {
      throw new Error('没有找到 prompts');
    }
    console.log(`   找到 ${result.prompts.length} 个 prompts`);
  })();

  await test('获取 session_start prompt', async () => {
    const result = await promptHandlers.getPrompt({
      params: { name: 'session_start', arguments: {} }
    });
    if (!result.messages || result.messages.length === 0) {
      throw new Error('Prompt 返回消息为空');
    }
    const text = result.messages[0].content.text;
    if (!text.includes('superpowers')) {
      throw new Error('Prompt 内容不正确');
    }
    console.log(`   消息长度: ${text.length} 字符`);
  })();

  await test('获取 brainstorm prompt (带参数)', async () => {
    const result = await promptHandlers.getPrompt({
      params: { name: 'brainstorm', arguments: { idea: '测试想法' } }
    });
    if (!result.messages || result.messages.length === 0) {
      throw new Error('Prompt 返回消息为空');
    }
    const text = result.messages[0].content.text;
    if (!text.includes('测试想法')) {
      throw new Error('Prompt 参数未正确注入');
    }
    console.log(`   消息长度: ${text.length} 字符`);
  })();

  // ===== 总结 =====
  console.log('\n' + '='.repeat(60));
  console.log(`测试完成: ${results.passed} 通过, ${results.failed} 失败`);
  console.log('='.repeat(60));

  if (results.failed > 0) {
    console.log('\n失败的测试:');
    results.tests
      .filter(t => t.status === 'FAIL')
      .forEach(t => {
        console.log(`  ✗ ${t.name}: ${t.error}`);
      });
    process.exit(1);
  } else {
    console.log('\n✨ 所有测试通过！MCP server 基本功能正常。');
    process.exit(0);
  }
}

// 运行测试
runTests().catch(error => {
  console.error('\n💥 测试运行失败:', error);
  process.exit(1);
});
