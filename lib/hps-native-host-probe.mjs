import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { renderMcpRegistration } from './hps-mcp-registration.mjs';
import { runWithTimeout } from './portable-timeout.mjs';

const SUPPORTED_PROBE_HOSTS = Object.freeze(['codex', 'claude', 'pi']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

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
    throw new RangeError('supported host must be codex, claude, or pi');
  }
  const installationRoot = assertSafeAbsolutePath(input?.installationRoot, 'installationRoot');
  const normalized = {
    installationRoot,
    cwd: assertSafeAbsolutePath(input?.cwd, 'cwd'),
    hpsCommand: path.join(installationRoot, 'bin', 'hps')
  };
  if (input?.model !== undefined && input?.model !== null) {
    if (typeof input.model !== 'string' || !MODEL_PATTERN.test(input.model)) {
      throw new TypeError('model must be a safe provider/model id');
    }
    normalized.model = input.model;
  }
  // Claude discovers MCP strictly through an explicit config file; pi reads
  // its agent directory, which the probe points at a temporary directory so no
  // user-level configuration is read or written.
  if (host === 'claude') {
    normalized.mcpConfigPath = assertSafeAbsolutePath(input?.mcpConfigPath, 'mcpConfigPath');
    normalized.debugFile = assertSafeAbsolutePath(input?.debugFile, 'debugFile');
  }
  if (host === 'pi') {
    normalized.agentDir = assertSafeAbsolutePath(input?.agentDir, 'agentDir');
  }
  return normalized;
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

function piAgentEnv(agentDir) {
  // `PI_CODING_AGENT_DIR` is the only supported override for the pi agent
  // directory, so the probe can supply an isolated mcp.json without touching
  // the user-level one.
  return { PI_CODING_AGENT_DIR: agentDir };
}

export function buildConnectionInvocation(host, input) {
  const normalized = normalizeInput(host, input);
  if (host === 'codex') {
    return {
      command: 'codex',
      args: ['mcp', 'list', '--json', ...codexMcpOverrides(normalized.hpsCommand)]
    };
  }
  if (host === 'pi') {
    return { command: 'pi', args: ['mcp', 'list', '--json'], env: piAgentEnv(normalized.agentDir) };
  }
  return {
    command: 'claude',
    args: [...claudeMcpArgs(normalized.mcpConfigPath), 'mcp', 'list']
  };
}

export function buildAgentInvocation(host, input) {
  const normalized = normalizeInput(host, input);
  if (host === 'pi') {
    // `--print` reads the prompt from stdin when no positional prompt is given,
    // which keeps the probe prompt out of argv. `--mode json` emits JSONL
    // events for the parser, and `--no-session` keeps the probe from writing a
    // session even inside the temporary agent directory. `--mcp-config` would
    // be shorter, but it is supplied by the mcp-adapter extension, while
    // PI_CODING_AGENT_DIR is core.
    const args = ['--print', '--mode', 'json', '--no-session'];
    if (normalized.model) args.push('--model', normalized.model);
    return { command: 'pi', args, env: piAgentEnv(normalized.agentDir), stdin: HOST_PROBE_PROMPT };
  }
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

export function parsePiProbeOutput(stdout) {
  const events = parsedAgentMessages(stdout);
  const candidates = events.flatMap((event) => findProbeObjects(event));
  const candidate = candidates.at(-1) ?? {};
  const executed = events.filter((event) => event.type === 'tool_execution_end' && typeof event.toolName === 'string');
  const hpsExecuted = executed.filter((event) => HPS_TOOL_PATTERN.test(event.toolName));
  const runtimeDoctorCalls = hpsExecuted.filter((event) => event.toolName === 'mcp__hps__runtime_doctor').length;
  const reportedToolCount = Number.isSafeInteger(candidate.visible_hps_tool_count) ? candidate.visible_hps_tool_count : null;
  return {
    initialized: events.some((event) => event.type === 'session'),
    // A successful direct call is the strongest evidence that the host actually
    // reached the HPS server rather than merely listing it.
    connected: hpsExecuted.length > 0 && hpsExecuted.every((event) => event.isError !== true),
    toolCount: reportedToolCount ?? new Set(hpsExecuted.map((event) => event.toolName)).size,
    toolNames: [...new Set(hpsExecuted.map((event) => event.toolName))],
    toolCallStatus: candidate.tool_call_status ?? null,
    runtimeDoctorCalls,
    authFailure: events.some((event) => /invalid[_ -]?api[_ -]?key|unauthorized|authentication/iu.test(
      JSON.stringify(event?.message?.error ?? event?.error ?? event?.message?.content ?? '')))
  };
}

function parsedAgentMessages(stdout) {
  return String(stdout).split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function parseEmbeddedJson(value) {
  const text = String(value).replace(/```[a-z]*\s*/giu, '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed !== text) return parsed;
  } catch { /* fall through to a balanced-substring attempt */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function findProbeObjects(value, result = [], seen = new Set()) {
  if (typeof value === 'string') {
    // Models commonly wrap the probe answer in a ```json fence; parse the
    // embedded object instead of discarding the whole string.
    const parsed = parseEmbeddedJson(value);
    if (parsed !== null) findProbeObjects(parsed, result, seen);
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
    return countRuntimeDoctorCalls(parseEmbeddedJson(value), seen);
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
      // Host-specific environment is additive: claude/codex rely on inheriting
      // the process environment, and pi needs it plus PI_CODING_AGENT_DIR.
      env: invocation.env ? { ...process.env, ...invocation.env } : undefined,
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

export async function runNativeHostProbe({ host, installationRoot, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, model = null, realAgentDir = null } = {}) {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), `hps-${host}-probe-`));
  const piAgentDir = path.join(artifactDir, 'pi-agent');
  if (host === 'pi') await fs.mkdir(piAgentDir, { recursive: true });
  const normalized = normalizeInput(host, {
    installationRoot,
    cwd,
    mcpConfigPath: path.join(cwd, '.hps-probe-mcp.json'),
    debugFile: path.join(cwd, '.hps-probe-debug.log'),
    agentDir: piAgentDir,
    model
  });
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

  if (host === 'pi') {
    // A direct exposure keeps `runtime_doctor` callable without codemode or
    // tool search, so the probe measures the host rather than the model.
    await fs.writeFile(
      path.join(piAgentDir, 'mcp.json'),
      `${JSON.stringify({ mcpServers: { hps: { command: normalized.hpsCommand, args: ['serve', '--stdio'], exposure: 'direct' } } }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    const sourceAgentDir = realAgentDir === null
      ? (process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'))
      : assertSafeAbsolutePath(realAgentDir, 'realAgentDir');
    for (const name of ['auth.json', 'models.json']) {
      const source = path.join(sourceAgentDir, name);
      if (await fs.lstat(source).then(() => true).catch(() => false)) {
        // Symlink rather than copy: the probe reuses the operator's credentials
        // without duplicating the secret, and pi keeps its sessions inside the
        // temporary agent directory.
        await fs.symlink(source, path.join(piAgentDir, name));
      }
    }
  }

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
  const parsedHost = host === 'claude' ? parseClaudeProbeOutput(hostResult.stdout)
    : host === 'pi' ? parsePiProbeOutput(hostResult.stdout)
    : parseCodexProbeOutput(hostResult.stdout);
  let connectionToolCount = null;
  if (host === 'codex') {
    const connection = await runStep(buildConnectionInvocation(host, agentInput), { timeoutMs, cwd: normalized.cwd });
    const connectionFile = await writeStep(artifactDir, 'codex-mcp-list', connection);
    let servers = [];
    try { servers = JSON.parse(connection.stdout); } catch { /* summarized below */ }
    const hps = Array.isArray(servers) ? servers.find((server) => server?.name === 'hps') : null;
    report.host_probe.connection = { ...connectionFile, connected: hps?.enabled === true && hps?.transport?.command === normalized.hpsCommand, server: hps ? { name: hps.name, enabled: hps.enabled, command: hps.transport?.command, args: hps.transport?.args } : null };
  } else if (host === 'pi') {
    const connection = await runStep(buildConnectionInvocation(host, agentInput), { timeoutMs, cwd: normalized.cwd });
    const connectionFile = await writeStep(artifactDir, 'pi-mcp-list', connection);
    let servers = [];
    try { servers = JSON.parse(connection.stdout)?.servers ?? []; } catch { /* summarized below */ }
    const hps = Array.isArray(servers) ? servers.find((server) => server?.name === 'hps') : null;
    const tools = Array.isArray(hps?.tools) ? hps.tools : [];
    connectionToolCount = tools.length;
    report.host_probe.connection = {
      ...connectionFile,
      connected: hps?.state === 'connected' && tools.length === 19,
      toolCount: tools.length,
      protocol: 'pi-mcp-list'
    };
  } else {
    report.host_probe.connection = { connected: parsedHost.connected === true, toolCount: parsedHost.toolCount, protocol: 'claude-session-init' };
  }
  const classificationInput = host === 'pi' && Number.isInteger(connectionToolCount)
    // `pi mcp list` independently proves the 19 declared tools, so the agent
    // step only has to prove a direct call. The model's own count is still
    // reported, but it is not required for a pass.
    ? { ...parsedHost, toolCount: Math.max(parsedHost.toolCount, connectionToolCount) }
    : parsedHost;
  report.host_probe.agent = { ...hostFile, classification: classifyHostResult(hostResult, classificationInput), ...parsedHost };
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
