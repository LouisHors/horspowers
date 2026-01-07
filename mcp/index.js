#!/usr/bin/env node

/**
 * Superpowers MCP Server - Entry Point
 * 
 * 这是 MCP server 的入口文件
 * 可以通过以下方式启动：
 * 
 * 1. 直接运行: node index.js
 * 2. NPM 脚本: npm start
 * 3. 通过 npx: npx superpowers-mcp
 * 4. 在 Cursor 配置中作为 MCP server
 */

import { startServer } from './src/server.js';

// 启动服务器
startServer();
