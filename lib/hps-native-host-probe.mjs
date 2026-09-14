import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { renderMcpRegistration } from './hps-mcp-registration.mjs';
import { runWithTimeout } from './portable-timeout.mjs';

const SUPPORTED_PROBE_HOSTS = Object.freeze(['codex', 'claude']);

export const HOST_PROBE_PROMPT = [
  'Inspect the HPS MCP tools registered for this session.',
  'Call runtime_doctor exactly once if the permission policy allows it.',
  'Return only one JSON object with keys hps_connected, visible_hps_tool_count, and tool_call_status.',
  'If the tool is registered but permission blocks the call, use tool_call_status "permission_blocked".'
].join(' ');

const MCP_PROTOCOL = '2025-11-25';
const DEFAULT_TIMEOUT_MS = 30_000;
const HPS_TOOL_PATTERN = /^mcp__hps__/u;

function assertSafeAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  if (/\p{Cc}/u.test(value)) throw new TypeError(`${label} must not contain control characters`);
  if (value.split(/[\\/]/u).some((segment) => segment === '.' || segment === '..')) {
    throw new TypeError(`${label} must be a normalized absolute path`);
  }
  return path.resolve(value);
}

function normalizeInput(host, input) {
  if (!SUPPORTED_PROBE_HOSTS.includes(host)) {
    throw new RangeError('supported host must be codex or claude');
  }
  const installationRoot = assertSafeAbsolutePath(input?.installationRoot, 'installationRoot');
  return {
    installationRoot,
    cwd: assertSafeAbsolutePath(input?.cwd, 'cwd'),
    mcpConfigPath: assertSafeAbsolutePath(input?.mcpConfigPath, 'mcpConfigPath'),
    debugFile: assertSafeAbsolutePath(input?.debugFile, 'debugFile'),
    hpsCommand: path.join(installationRoot, 'bin', 'hps')
  };
}

function codexMcpOverrides(hpsCommand) {
  return [
    '-c', `mcp_servers.hps.command=${JSON.stringify(hpsCommand)}`,
    '-c', 'mcp_servers.hps.args=["serve","--stdio"]'
  ];
}

function claudeMcpArgs(mcpConfigPath) {
  return [
    // Read user-level auth/env settings, but keep MCP discovery strictly
    // project-local through the temporary config below. This supports API-key
    // users without writing or importing global MCP registrations.
    '--setting-sources', 'user',
    '--mcp-config', mcpConfigPath,
    '--strict-mcp-config'
  ];
}

export function buildConnectionInvocation(host, input) {
  const normalized = normalizeInput(host, input);
  if (host === 'codex') {
    return {
      command: 'codex',
      args: ['mcp', 'list', '--json', ...codexMcpOverrides(normalized.hpsCommand)]
    };
  }
  return {
    command: 'claude',
    args: [...claudeMcpArgs(normalized.mcpConfigPath), 'mcp', 'list']
  };
}

export function buildAgentInvocation(host, input) {
  const normalized = normalizeInput(host, input);
  if (host === 'codex') {
    return {
      command: 'codex',
      args: [
        '--sandbox', 'read-only', '--ask-for-approval', 'never', '--cd', normalized.cwd,
        ...codexMcpOverrides(normalized.hpsCommand),
        'exec', '--json', '--ignore-user-config', '--strict-config', '--ephemeral',
        '--skip-git-repo-check', '-'
      ],
      stdin: HOST_PROBE_PROMPT
    };
  }
  return {
    command: 'claude',
    args: [
      ...claudeMcpArgs(normalized.mcpConfigPath),
      '--permission-mode', 'dontAsk', '--no-session-persistence',
      '--output-format', 'stream-json', '--verbose', '--debug-file', normalized.debugFile,
      '--print'
    ],
    stdin: HOST_PROBE_PROMPT
  };
}

function mcpFrame(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

export function parseMcpProbeOutput(stdout) {
  const messages = String(stdout).split(/\r?\n/u).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((message) => message && message.jsonrpc === '2.0');
  const initialize = messages.find((message) => message.id === 'initialize');
  const listed = messages.find((message) => message.id === 'tools');
  const tools = Array.isArray(listed?.result?.tools) ? listed.result.tools : [];
  return {
    initialized: Boolean(initialize?.result),
    protocolVersion: initialize?.result?.protocolVersion ?? null,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool?.name).filter((name) => typeof name === 'string'),
    toolsListOk: Boolean(listed?.result?.tools)
  };
}

export function parseVersionOutput(stdout) {
  try {
    const value = JSON.parse(String(stdout).trim());
    return {
      valid: value?.command === 'hps' && value?.schema_version === 1 && typeof value?.version === 'string',
      value
    };
  } catch {
    return { valid: false, value: null };
  }
}

export function parseCallOutput(stdout) {
  try {
    const value = JSON.parse(String(stdout).trim());
    return {
      valid: value?.schema_version === 1 && value?.request_id === 'native-host-probe' &&
        value?.status === 'ok' && value?.error === null,
      value
    };
  } catch {
    return { valid: false, value: null };
  }
}

export function parseClaudeProbeOutput(stdout) {
  const messages = String(stdout).split(/\r?\n/u).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const init = messages.find((message) => message.type === 'system' && message.subtype === 'init');
  const tools = Array.isArray(init?.tools) ? init.tools : [];
  const hpsTools = tools.filter((name) => HPS_TOOL_PATTERN.test(name));
  const server = Array.isArray(init?.mcp_servers) ? init.mcp_servers.find((entry) => entry?.name === 'hps') : null;
  const runtimeDoctorCalls = messages.reduce((count, message) => {
    const blocks = Array.isArray(message?.message?.content) ? message.message.content : [];
    return count + blocks.filter((block) => block?.type === 'tool_use' && block?.name === 'mcp__hps__runtime_doctor').length;
  }, 0);
  const toolCallStatus = messages.some((message) => /permission.*denied|permission.*blocked/iu.test(JSON.stringify(message)))
    ? 'permission_blocked' : null;
  return {
    initialized: Boolean(init),
    connected: server?.status === 'connected',
    toolCount: hpsTools.length,
    toolNames: hpsTools,
    authFailure: messages.some((message) => message?.error === 'authentication_failed' || /not logged in|authentication/iu.test(message?.result ?? '')),
    runtimeDoctorCalls,
    toolCallStatus
  };
}

function parsedAgentMessages(stdout) {
  return String(stdout).split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function findProbeObjects(value, result = [], seen = new Set()) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed !== value) findProbeObjects(parsed, result, seen);
    } catch { /* ordinary text */ }
    return result;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) findProbeObjects(child, result, seen);
    return result;
  }
  if (Object.hasOwn(value, 'hps_connected') || Object.hasOwn(value, 'visible_hps_tool_count') ||
      Object.hasOwn(value, 'tool_call_status')) result.push(value);
  for (const child of Object.values(value)) findProbeObjects(child, result, seen);
  return result;
}

function countRuntimeDoctorCalls(value, seen = new Set()) {
  if (typeof value === 'string') {
    try { return countRuntimeDoctorCalls(JSON.parse(value), seen); } catch { return 0; }
  }
  if (!value || typeof value !== 'object') return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((count, child) => count + countRuntimeDoctorCalls(child, seen), 0);
  const isCall = ['tool_use', 'function_call', 'mcp_tool_call'].includes(value.type) &&
    (value.name === 'mcp__hps__runtime_doctor' || value.tool_name === 'mcp__hps__runtime_doctor' ||
      value.invocation?.server === 'hps' && value.invocation?.tool === 'runtime_doctor');
  return (isCall ? 1 : 0) + Object.values(value).reduce((count, child) => count + countRuntimeDoctorCalls(child, seen), 0);
}

export function parseCodexProbeOutput(stdout) {
  const messages = parsedAgentMessages(stdout);
  const candidates = messages.flatMap((message) => findProbeObjects(message));
  const candidate = candidates.at(-1) ?? {};
  const runtimeDoctorCalls = messages.reduce((count, message) => count + countRuntimeDoctorCalls(message), 0);
  const permissionBlocked = messages.some((message) => /permission.*denied|permission.*blocked/iu.test(JSON.stringify(message)));
  const authFailure = messages.some((message) => message?.error === 'authentication_failed' ||
    message?.error === 'invalid_api_key' || message?.type === 'authentication_error');
  return {
    initialized: messages.some((message) => message.type === 'thread.started'),
    connected: candidate.hps_connected === true,
    toolCount: Number.isSafeInteger(candidate.visible_hps_tool_count) ? candidate.visible_hps_tool_count : 0,
    toolCallStatus: candidate.tool_call_status === 'permission_blocked' || permissionBlocked ? 'permission_blocked' : candidate.tool_call_status ?? null,
    runtimeDoctorCalls,
    authFailure
  };
}

function classifyHostResult(result, parsed) {
  if (result.error_code === 'host_cli_not_found') return 'prerequisite_cli';
  if (result.timedOut) return 'timeout';
  if (parsed.authFailure === true || /401|invalid[_ -]?api[_ -]?key|api key/iu.test(result.stderr)) {
    return 'prerequisite_auth';
  }
  if (/unexpected argument|usage:/iu.test(result.stderr)) return 'prerequisite_cli';
  if (result.exitCode === 0 && parsed.connected === true && parsed.toolCount === 19 &&
      (parsed.runtimeDoctorCalls === 1 || parsed.toolCallStatus === 'permission_blocked')) return 'pass';
  return 'failed';
}

export { classifyHostResult };

async function runStep(invocation, { timeoutMs, cwd, stdin = null } = {}) {
  try {
    return await runWithTimeout({
      timeoutMs,
      command: invocation.command,
      args: invocation.args,
      cwd,
      stdin: stdin === null ? null : Readable.from([stdin])
    });
  } catch (error) {
    return {
      exitCode: error?.code === 'ENOENT' ? 127 : 1,
      signal: null,
      timedOut: false,
      error_code: error?.code === 'ENOENT' ? 'host_cli_not_found' : 'host_probe_spawn_failed',
      stdout: '',
      stderr: error?.code === 'ENOENT' ? 'host CLI not found' : 'host probe process could not start'
    };
  }
}

async function ensureNativeRoot(installationRoot) {
  const root = await fs.lstat(installationRoot).catch(() => null);
  const entry = await fs.lstat(path.join(installationRoot, 'bin', 'hps')).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink() || !entry?.isFile() || entry.isSymbolicLink() || (process.platform !== 'win32' && (entry.mode & 0o111) === 0)) {
    const error = new Error('installation root must contain a native executable bin/hps');
    error.code = 'native_installation_missing';
    throw error;
  }
}

function callRequest(cwd) {
  return JSON.stringify({
    schema_version: 1,
    request_id: 'native-host-probe',
    operation: 'runtime_doctor',
    cwd,
    input: {}
  });
}

async function writeStep(artifactDir, name, result) {
  await fs.writeFile(path.join(artifactDir, `${name}.stdout`), result.stdout ?? '', { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(path.join(artifactDir, `${name}.stderr`), result.stderr ?? '', { encoding: 'utf8', flag: 'wx' });
  return { exitCode: result.exitCode, timedOut: result.timedOut, signal: result.signal };
}

export async function runNativeHostProbe({ host, installationRoot, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const normalized = normalizeInput(host, {
    installationRoot,
    cwd,
    mcpConfigPath: path.join(cwd, '.hps-probe-mcp.json'),
    debugFile: path.join(cwd, '.hps-probe-debug.log')
  });
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), `hps-${host}-probe-`));
  const configPath = path.join(artifactDir, `${host}.mcp.json`);
  const report = {
    schema_version: 1,
    host,
    installation_root: normalized.installationRoot,
    cwd: normalized.cwd,
    artifact_dir: artifactDir,
    config_path: configPath,
    direct: {},
    host_probe: {}
  };

  try {
    await ensureNativeRoot(normalized.installationRoot);
  } catch (error) {
    report.status = 'blocked_prerequisite';
    report.error_code = error?.code ?? 'native_installation_missing';
    report.error = error?.message ?? 'native installation root is unavailable';
    await fs.writeFile(path.join(artifactDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return report;
  }

  await fs.writeFile(configPath, `${JSON.stringify(renderMcpRegistration(host, normalized.installationRoot), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });

  const version = await runStep({ command: normalized.hpsCommand, args: ['version', '--json'] }, { timeoutMs, cwd: normalized.cwd });
  report.direct.version = { ...(await writeStep(artifactDir, 'hps-version', version)), ...parseVersionOutput(version.stdout) };
  const call = await runStep({ command: normalized.hpsCommand, args: ['call'] }, { timeoutMs, cwd: normalized.cwd, stdin: callRequest(normalized.cwd) });
  report.direct.runtime_doctor = { ...(await writeStep(artifactDir, 'hps-runtime-doctor', call)), ...parseCallOutput(call.stdout) };
  const mcpInput = [
    mcpFrame('initialize', 'initialize', { protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: 'hps-native-probe', version: '1' } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    mcpFrame('tools', 'tools/list'),
    ''
  ].join('\n');
  const mcp = await runStep({ command: normalized.hpsCommand, args: ['serve', '--stdio'] }, { timeoutMs, cwd: normalized.cwd, stdin: mcpInput });
  report.direct.mcp = { ...(await writeStep(artifactDir, 'hps-mcp', mcp)), ...parseMcpProbeOutput(mcp.stdout) };

  const agentInput = { ...normalized, mcpConfigPath: configPath, debugFile: path.join(artifactDir, `${host}.debug.log`) };
  const invocation = buildAgentInvocation(host, agentInput);
  const hostResult = await runStep(invocation, { timeoutMs, cwd: normalized.cwd, stdin: invocation.stdin });
  const hostFile = await writeStep(artifactDir, `${host}-agent`, hostResult);
  const parsedHost = host === 'claude' ? parseClaudeProbeOutput(hostResult.stdout) : parseCodexProbeOutput(hostResult.stdout);
  report.host_probe.agent = { ...hostFile, classification: classifyHostResult(hostResult, parsedHost), ...parsedHost };
  if (host === 'codex') {
    const connection = await runStep(buildConnectionInvocation(host, agentInput), { timeoutMs, cwd: normalized.cwd });
    const connectionFile = await writeStep(artifactDir, 'codex-mcp-list', connection);
    let servers = [];
    try { servers = JSON.parse(connection.stdout); } catch { /* summarized below */ }
    const hps = Array.isArray(servers) ? servers.find((server) => server?.name === 'hps') : null;
    report.host_probe.connection = { ...connectionFile, connected: hps?.enabled === true && hps?.transport?.command === normalized.hpsCommand, server: hps ? { name: hps.name, enabled: hps.enabled, command: hps.transport?.command, args: hps.transport?.args } : null };
  } else {
    report.host_probe.connection = { connected: parsedHost.connected === true, toolCount: parsedHost.toolCount, protocol: 'claude-session-init' };
  }
  const directReady = report.direct.version.exitCode === 0 && report.direct.version.valid &&
    report.direct.runtime_doctor.exitCode === 0 && report.direct.runtime_doctor.valid &&
    report.direct.mcp.exitCode === 0 && report.direct.mcp.initialized && report.direct.mcp.protocolVersion &&
    report.direct.mcp.toolsListOk && report.direct.mcp.toolCount === 19;
  const hostClassification = report.host_probe.agent.classification;
  const blockedPrerequisite = ['prerequisite_auth', 'prerequisite_cli'].includes(hostClassification);
  report.status = directReady && report.host_probe.connection.connected
    ? (hostClassification === 'pass' ? 'pass' : blockedPrerequisite ? 'blocked_prerequisite' : 'failed')
    : blockedPrerequisite ? 'blocked_prerequisite' : 'failed';
  await fs.writeFile(path.join(artifactDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

export { DEFAULT_TIMEOUT_MS, SUPPORTED_PROBE_HOSTS };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // This module is intentionally library-first; the public executable is scripts/run-hps-native-host-probe.mjs.
}
