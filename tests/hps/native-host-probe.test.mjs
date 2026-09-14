import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentInvocation,
  buildConnectionInvocation,
  HOST_PROBE_PROMPT,
  classifyHostResult,
  parseCodexProbeOutput,
  parseClaudeProbeOutput,
  parseMcpProbeOutput,
  parseCallOutput,
  parseVersionOutput,
  runNativeHostProbe
} from '../../lib/hps-native-host-probe.mjs';

const input = Object.freeze({
  installationRoot: '/native/horspowers',
  cwd: '/workspace/project',
  mcpConfigPath: '/private/tmp/hps-probe-123/claude.mcp.json',
  debugFile: '/private/tmp/hps-probe-123/claude.debug.log'
});

test('Codex probe uses invocation-local MCP configuration and stdin prompt', () => {
  const connection = buildConnectionInvocation('codex', input);
  assert.equal(connection.command, 'codex');
  assert.deepEqual(connection.args.slice(0, 3), ['mcp', 'list', '--json']);
  assert.ok(connection.args.includes('mcp_servers.hps.command="/native/horspowers/bin/hps"'));

  const agent = buildAgentInvocation('codex', input);
  assert.equal(agent.command, 'codex');
  assert.ok(agent.args.includes('--ignore-user-config'));
  assert.ok(agent.args.includes('--ephemeral'));
  assert.ok(agent.args.includes('read-only'));
  assert.equal(agent.stdin, HOST_PROBE_PROMPT);
  assert.equal(agent.args.includes(HOST_PROBE_PROMPT), false);
});

test('Claude probe uses only the temporary MCP config and never persists a session', () => {
  const connection = buildConnectionInvocation('claude', input);
  assert.equal(connection.command, 'claude');
  assert.ok(connection.args.includes('--mcp-config'));
  assert.ok(connection.args.includes(input.mcpConfigPath));
  assert.ok(connection.args.includes('--strict-mcp-config'));

  const agent = buildAgentInvocation('claude', input);
  assert.equal(agent.command, 'claude');
  assert.ok(agent.args.includes('--no-session-persistence'));
  assert.ok(agent.args.includes('dontAsk'));
  assert.ok(agent.args.includes('user'));
  assert.ok(agent.args.includes(input.debugFile));
  assert.equal(agent.stdin, HOST_PROBE_PROMPT);
  assert.equal(agent.args.includes(HOST_PROBE_PROMPT), false);
});

test('native host probe rejects unsupported hosts and unsafe paths', () => {
  assert.throws(() => buildAgentInvocation('opencode', input), /supported host/iu);
  assert.throws(() => buildAgentInvocation('codex', { ...input, installationRoot: 'relative' }), /absolute/iu);
  assert.throws(() => buildAgentInvocation('claude', { ...input, cwd: '/tmp/../escape' }), /normalized/iu);
  assert.throws(() => buildAgentInvocation('claude', { ...input, mcpConfigPath: '/tmp/config\n.json' }), /control/iu);
});

test('probe parsers report the real Claude connection and canonical 19 HPS tools', () => {
  const toolNames = Array.from({ length: 19 }, (_, index) => `mcp__hps__tool_${index}`);
  const claude = parseClaudeProbeOutput(JSON.stringify({
    type: 'system', subtype: 'init', tools: ['Read', ...toolNames], mcp_servers: [{ name: 'hps', status: 'connected' }]
  }));
  assert.equal(claude.connected, true);
  assert.equal(claude.toolCount, 19);

  const mcp = parseMcpProbeOutput([
    JSON.stringify({ jsonrpc: '2.0', id: 'initialize', result: { protocolVersion: '2025-11-25' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 'tools', result: { tools: toolNames.map((name) => ({ name })) } })
  ].join('\n'));
  assert.equal(mcp.initialized, true);
  assert.equal(mcp.toolsListOk, true);
  assert.equal(mcp.toolCount, 19);
});

test('Codex parser accepts JSONL agent message text and counts MCP invocation events', () => {
  const codex = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', invocation: { server: 'hps', tool: 'runtime_doctor' } } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ hps_connected: true, visible_hps_tool_count: 19, tool_call_status: 'ok' }) } })
  ].join('\n');
  const parsed = parseCodexProbeOutput(codex);
  assert.equal(parsed.initialized, true);
  assert.equal(parsed.connected, true);
  assert.equal(parsed.toolCount, 19);
  assert.equal(parsed.runtimeDoctorCalls, 1);
  assert.equal(parsed.toolCallStatus, 'ok');
});

test('Codex and Claude permission blocks are preserved as a distinct probe outcome', () => {
  const codex = parseCodexProbeOutput(JSON.stringify({
    type: 'thread.started',
    item: { type: 'agent_message', text: JSON.stringify({ hps_connected: true, visible_hps_tool_count: 19, tool_call_status: 'permission_blocked' }) }
  }));
  assert.equal(codex.toolCallStatus, 'permission_blocked');
  assert.equal(classifyHostResult({ exitCode: 0, timedOut: false, stdout: '', stderr: '' }, { ...codex, connected: true, toolCount: 19 }), 'pass');

  const claude = parseClaudeProbeOutput(JSON.stringify({ type: 'result', result: 'permission denied calling tool' }));
  assert.equal(claude.toolCallStatus, 'permission_blocked');
});

test('host probe classification distinguishes prerequisites, timeout, and failures', () => {
  const parsed = { connected: false, toolCount: 0, runtimeDoctorCalls: 0 };
  assert.equal(classifyHostResult({ error_code: 'host_cli_not_found', timedOut: false, stdout: '', stderr: '' }, parsed), 'prerequisite_cli');
  assert.equal(classifyHostResult({ exitCode: 124, timedOut: true, stdout: '', stderr: '' }, parsed), 'timeout');
  assert.equal(classifyHostResult({ exitCode: 1, timedOut: false, stdout: '', stderr: 'boom' }, parsed), 'failed');
  assert.equal(classifyHostResult({ exitCode: 1, timedOut: false, stdout: '', stderr: '401 unauthorized' }, parsed), 'prerequisite_auth');
  assert.equal(classifyHostResult({ exitCode: 0, timedOut: false, stdout: 'model reasoning mentions authentication but succeeded', stderr: '' }, { connected: true, toolCount: 19, runtimeDoctorCalls: 1, toolCallStatus: 'permission_blocked', authFailure: false }), 'pass');
});

test('direct HPS output parsers enforce the native protocol envelopes', () => {
  assert.equal(parseVersionOutput('{"command":"hps","schema_version":1,"version":"1.0.0"}').valid, true);
  assert.equal(parseVersionOutput('{"command":"other"}').valid, false);
  assert.equal(parseCallOutput('{"schema_version":1,"request_id":"native-host-probe","status":"ok","result":{},"error":null}').valid, true);
  assert.equal(parseCallOutput('{"status":"error"}').valid, false);
});

test('missing native installation root is a blocked prerequisite with a durable error code', async () => {
  const report = await runNativeHostProbe({
    host: 'codex',
    installationRoot: '/tmp/hps-native-probe-installation-does-not-exist',
    cwd: '/tmp'
  });
  assert.equal(report.status, 'blocked_prerequisite');
  assert.equal(report.error_code, 'native_installation_missing');
  assert.match(report.artifact_dir, /hps-codex-probe-/u);
});
