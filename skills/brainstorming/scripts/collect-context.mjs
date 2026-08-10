#!/usr/bin/env node
import { access, readFile as readFileFromDisk } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const MAX_QUERY_BYTES = 4 * 1024;
const MAX_KNOWN_ENTRIES = 12;
const MAX_ENTRY_BYTES = 32 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_FINAL_BYTES = 256 * 1024;
const OVERALL_TIMEOUT_MS = 10_000;
const EXCLUDED_DIRS = ['.git', 'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build', 'target', 'coverage', '.cache'];
const SENSITIVE_PATTERNS = [
  /^\.env(?:\..*)?$/iu, /\.pem$/iu, /\.key$/iu, /\.p12$/iu, /\.pfx$/iu,
  /^id_rsa/iu, /^id_ed25519/iu, /^\.npmrc$/iu, /^\.pypirc$/iu,
  /^credentials/iu, /^secrets/iu, /token/iu, /\.kdbx$/iu
];
const SENSITIVE_GLOBS = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '.npmrc', '.pypirc', 'credentials*', 'secrets*', '*token*', '*.kdbx'];
const DEFAULT_ENTRIES = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];

function isAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value);
}

function insideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isSensitivePath(filePath) {
  const base = path.basename(filePath);
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(base));
}

function rgExclusions() {
  return [
    ...EXCLUDED_DIRS.flatMap((dir) => ['-g', `!${dir}/**`]),
    ...SENSITIVE_GLOBS.flatMap((glob) => ['-g', `!${glob}`, '-g', `!**/${glob}`])
  ];
}

function grepExclusions() {
  return [
    ...EXCLUDED_DIRS.flatMap((dir) => [`--exclude-dir=${dir}`]),
    ...SENSITIVE_GLOBS.map((glob) => `--exclude=${glob}`)
  ];
}

export function validateContextInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('collector input must be an object');
  const expected = new Set(['schema_version', 'cwd', 'query', 'wiki_root', 'known_entry_files']);
  const keys = Object.keys(input);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) throw new TypeError('collector input fields are invalid');
  if (input.schema_version !== SCHEMA_VERSION) throw new TypeError('unsupported collector schema_version');
  if (!isAbsolutePath(input.cwd)) throw new TypeError('cwd must be an absolute path');
  if (typeof input.query !== 'string' || Buffer.byteLength(input.query, 'utf8') > MAX_QUERY_BYTES) throw new TypeError('query must be at most 4 KiB');
  if (input.wiki_root !== null && !isAbsolutePath(input.wiki_root)) throw new TypeError('wiki_root must be null or an absolute path');
  if (!Array.isArray(input.known_entry_files) || input.known_entry_files.length > MAX_KNOWN_ENTRIES) throw new TypeError('known_entry_files exceeds its limit');
  for (const entry of input.known_entry_files) {
    if (!isAbsolutePath(entry) || !insideRoot(entry, input.cwd)) throw new TypeError('known entry files must be absolute paths inside cwd');
  }
  return input;
}

function clip(value, maxBytes) {
  const text = String(value ?? '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

function branch({ status = 'ok', tool = null, items = [], durationMs = 0, truncated = false, errorCode = null }) {
  return {
    status,
    tool,
    items,
    duration_ms: Math.max(0, Math.round(durationMs)),
    truncated,
    error_code: errorCode
  };
}

function item(sourceType, uriOrPath, excerpt, extras = {}) {
  return {
    source_type: sourceType,
    uri_or_path: uriOrPath,
    title: path.basename(uriOrPath) || uriOrPath,
    excerpt: clip(excerpt, 1_024).text,
    observed_at: new Date().toISOString(),
    ...extras
  };
}

function parseTextMatches(stdout, root, sourceType, maximum = 40) {
  const seen = new Set();
  const items = [];
  for (const line of stdout.split(/\r?\n/gu)) {
    const match = line.match(/^(.*?):(\d+):(.*)$/u);
    if (!match) continue;
    const filePath = path.isAbsolute(match[1]) ? match[1] : path.join(root, match[1]);
    const identity = `${filePath}:${match[2]}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    items.push(item(sourceType, filePath, match[3], { line: Number(match[2]) }));
    if (items.length === maximum) break;
  }
  return items;
}

function parseQmdMatches(stdout, maximum = 8) {
  const seen = new Set();
  const items = [];
  for (const line of stdout.split(/\r?\n/gu)) {
    const match = line.match(/^(qmd:\/\/\S+?)(?::\s*|\s+)(.*)$/u);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    items.push(item('wiki', match[1], match[2]));
    if (items.length === maximum) break;
  }
  return items;
}

function parseGitLog(stdout) {
  return stdout.split(/\r?\n/gu).filter(Boolean).slice(0, 20).map((line) => {
    const [commit, timestamp, subject = ''] = line.split('\t');
    return item('git', commit, subject, { commit, observed_at: timestamp ? new Date(Number(timestamp) * 1_000).toISOString() : new Date().toISOString() });
  });
}

function acceptedSearchExit(result) {
  return result.code === 0 || result.code === 1;
}

export async function spawnCommand({ command, args, cwd, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (previous, chunk, limit) => Buffer.concat([previous, Buffer.from(chunk)]).subarray(0, limit);
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({
        code: code ?? 1,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timed_out: timedOut,
        truncated: stdout.length >= MAX_STDOUT_BYTES || stderr.length >= MAX_STDERR_BYTES,
        error
      });
    };
    const abort = () => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 100).unref();
    };
    const timer = setTimeout(abort, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk, MAX_STDOUT_BYTES); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk, MAX_STDERR_BYTES); });
    child.on('error', (error) => finish(1, error));
    child.on('close', (code) => finish(code));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function commandAvailable(command, cwd) {
  const result = await spawnCommand({ command, args: ['--version'], cwd, timeoutMs: 500, signal: null });
  return result.code === 0;
}

async function detectCapabilities(cwd) {
  const [rg, qmd, git, grep] = await Promise.all(['rg', 'qmd', 'git', 'grep'].map((command) => commandAvailable(command, cwd)));
  const gitRoot = git ? await spawnCommand({ command: 'git', args: ['rev-parse', '--is-inside-work-tree'], cwd, timeoutMs: 500, signal: null }) : { code: 1 };
  const untracked = gitRoot.code === 0
    ? await spawnCommand({ command: 'git', args: ['status', '--porcelain', '--untracked-files=all'], cwd, timeoutMs: 500, signal: null })
    : { stdout: '' };
  const grepHelp = grep ? await spawnCommand({ command: 'grep', args: ['--help'], cwd, timeoutMs: 500, signal: null }) : { stdout: '' };
  return {
    rg,
    qmd,
    git: gitRoot.code === 0,
    grepExcludeDir: grepHelp.stdout.includes('--exclude-dir'),
    untracked: untracked.stdout.split(/\r?\n/gu).some((line) => line.startsWith('?? '))
  };
}

async function runSearch(runCommand, command, args, cwd, timeoutMs, signal) {
  const result = await runCommand({ command, args, cwd, timeoutMs, signal });
  const stdout = clip(result.stdout, MAX_STDOUT_BYTES);
  return { ...result, stdout: stdout.text, truncated: Boolean(result.truncated || stdout.truncated) };
}

async function enumerateFiles({ capabilities, runCommand, cwd, signal }) {
  if (capabilities.rg) return { tool: 'rg --files', result: await runSearch(runCommand, 'rg', ['--files', ...rgExclusions()], cwd, 3_000, signal) };
  if (capabilities.git) return { tool: 'git ls-files', result: await runSearch(runCommand, 'git', ['ls-files'], cwd, 3_000, signal) };
  return { tool: 'find', result: await runSearch(runCommand, 'find', [cwd, ...EXCLUDED_DIRS.flatMap((dir) => ['-path', path.join(cwd, dir), '-prune', '-o']), '-type', 'f', '-print'], cwd, 3_000, signal) };
}

async function collectRepository(context, dependencies, signal) {
  const started = performance.now();
  const { capabilities, runCommand } = dependencies;
  try {
    let tool;
    let result;
    if (capabilities.rg) {
      tool = 'rg -n';
      result = await runSearch(runCommand, 'rg', ['-n', '--no-heading', '--color=never', ...rgExclusions(), '--', context.query, context.cwd], context.cwd, 3_000, signal);
    } else if (capabilities.git && !capabilities.untracked) {
      const listed = await enumerateFiles({ capabilities, runCommand, cwd: context.cwd, signal });
      const candidates = listed.result.stdout.split(/\r?\n/gu).filter((file) => file && !isSensitivePath(file)).slice(0, 200);
      tool = 'git grep -n';
      result = await runSearch(runCommand, 'git', ['grep', '-n', '-e', context.query, '--', ...candidates], context.cwd, 3_000, signal);
      result.truncated ||= listed.result.truncated;
    } else if (capabilities.grepExcludeDir) {
      tool = 'grep -RIn';
      result = await runSearch(runCommand, 'grep', ['-RIn', ...grepExclusions(), '--', context.query, context.cwd], context.cwd, 3_000, signal);
    } else {
      const listed = await enumerateFiles({ capabilities, runCommand, cwd: context.cwd, signal });
      const candidates = listed.result.stdout.split(/\r?\n/gu).filter((file) => file && !isSensitivePath(file)).slice(0, 200).map((file) => path.isAbsolute(file) ? file : path.join(context.cwd, file));
      tool = 'grep -n (enumerated)';
      result = await runSearch(runCommand, 'grep', ['-n', '--', context.query, ...candidates], context.cwd, 3_000, signal);
      result.truncated ||= listed.result.truncated;
    }
    if (result.timed_out) return branch({ status: 'timeout', tool, durationMs: performance.now() - started, truncated: true, errorCode: 'TIMEOUT' });
    if (!acceptedSearchExit(result)) return branch({ status: 'failed', tool, durationMs: performance.now() - started, truncated: result.truncated, errorCode: 'COMMAND_FAILED' });
    const items = parseTextMatches(result.stdout, context.cwd, 'repository');
    return branch({ status: result.code === 1 ? 'ok' : 'ok', tool, items, durationMs: performance.now() - started, truncated: result.truncated || items.length >= 40 });
  } catch {
    return branch({ status: 'failed', tool: null, durationMs: performance.now() - started, errorCode: 'COMMAND_FAILED' });
  }
}

async function collectWiki(context, dependencies, signal) {
  const started = performance.now();
  const { capabilities, runCommand } = dependencies;
  try {
    if (capabilities.qmd) {
      const search = await runSearch(runCommand, 'qmd', ['search', context.query, '-c', 'my-code-wiki', '-n', '8'], context.cwd, 4_000, signal);
      if (search.timed_out) return branch({ status: 'timeout', tool: 'qmd search', durationMs: performance.now() - started, truncated: true, errorCode: 'TIMEOUT' });
      const searchSucceeded = search.code === 0;
      const searchItems = searchSucceeded ? parseQmdMatches(search.stdout) : [];
      if (searchItems.length >= 3) return branch({ status: searchSucceeded ? 'ok' : 'failed', tool: 'qmd search', items: searchItems, durationMs: performance.now() - started, truncated: search.truncated, errorCode: searchSucceeded ? null : 'QMD_SEARCH_FAILED' });
      const semantic = await runSearch(runCommand, 'qmd', ['query', context.query, '-c', 'my-code-wiki', '-n', '8', '--no-rerank'], context.cwd, 8_000, signal);
      const semanticSucceeded = semantic.code === 0;
      const semanticItems = semanticSucceeded ? parseQmdMatches(semantic.stdout) : [];
      const combined = [...searchItems, ...semanticItems].filter((entry, index, entries) => entries.findIndex((candidate) => candidate.uri_or_path === entry.uri_or_path) === index).slice(0, 8);
      return branch({ status: semantic.timed_out ? 'timeout' : !searchSucceeded ? 'failed' : semanticSucceeded ? 'ok' : 'partial', tool: 'qmd search + qmd query', items: combined, durationMs: performance.now() - started, truncated: search.truncated || semantic.truncated || combined.length >= 8, errorCode: semantic.timed_out ? 'TIMEOUT' : semanticSucceeded ? null : 'QMD_QUERY_FAILED' });
    }
    if (!context.wiki_root) return branch({ status: 'skipped', errorCode: 'NO_TRUSTED_WIKI', durationMs: performance.now() - started });
    const result = await runSearch(runCommand, 'grep', ['-RIn', ...grepExclusions(), '--include=*.md', '--', context.query, context.wiki_root], context.wiki_root, 4_000, signal);
    if (result.timed_out) return branch({ status: 'timeout', tool: 'grep -RIn', durationMs: performance.now() - started, truncated: true, errorCode: 'TIMEOUT' });
    if (!acceptedSearchExit(result)) return branch({ status: 'failed', tool: 'grep -RIn', durationMs: performance.now() - started, errorCode: 'COMMAND_FAILED' });
    const items = parseTextMatches(result.stdout, context.wiki_root, 'wiki', 8);
    return branch({ tool: 'grep -RIn', items, durationMs: performance.now() - started, truncated: result.truncated || items.length >= 8 });
  } catch {
    return branch({ status: 'failed', durationMs: performance.now() - started, errorCode: 'COMMAND_FAILED' });
  }
}

async function collectGit(context, dependencies, signal) {
  const started = performance.now();
  if (!dependencies.capabilities.git) return branch({ status: 'skipped', durationMs: performance.now() - started, errorCode: 'NOT_GIT' });
  try {
    const result = await runSearch(dependencies.runCommand, 'git', ['log', '-n', '20', '--pretty=format:%H%x09%ct%x09%s'], context.cwd, 2_000, signal);
    if (result.timed_out) return branch({ status: 'timeout', tool: 'git log', durationMs: performance.now() - started, truncated: true, errorCode: 'TIMEOUT' });
    if (result.code !== 0) return branch({ status: 'failed', tool: 'git log', durationMs: performance.now() - started, errorCode: 'COMMAND_FAILED' });
    return branch({ tool: 'git log', items: parseGitLog(result.stdout), durationMs: performance.now() - started, truncated: result.truncated });
  } catch {
    return branch({ status: 'failed', tool: 'git log', durationMs: performance.now() - started, errorCode: 'COMMAND_FAILED' });
  }
}

async function collectEntries(context, dependencies, signal) {
  const started = performance.now();
  const entries = [...new Set([...DEFAULT_ENTRIES.map((name) => path.join(context.cwd, name)), ...context.known_entry_files])].slice(0, MAX_KNOWN_ENTRIES);
  try {
    const reads = await Promise.all(entries.map(async (entry) => {
      if (signal.aborted) return { timeout: true };
      if (isSensitivePath(entry)) return { sensitive: true };
      try {
        const content = await dependencies.readFile(entry, MAX_ENTRY_BYTES);
        const clipped = clip(content, MAX_ENTRY_BYTES);
        return { entry: item('entry', entry, clipped.text), truncated: clipped.truncated };
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      }
    }));
    const sensitive = reads.filter((value) => value?.sensitive).length;
    const items = reads.flatMap((value) => value?.entry ? [value.entry] : []);
    const truncated = reads.some((value) => value?.truncated);
    if (reads.some((value) => value?.timeout)) {
      return { result: branch({ status: 'timeout', tool: 'readFile', items, durationMs: performance.now() - started, truncated: true, errorCode: 'TIMEOUT' }), sensitive };
    }
    return { result: branch({ tool: 'readFile', items, durationMs: performance.now() - started, truncated }), sensitive };
  } catch {
    return { result: branch({ status: 'failed', tool: 'readFile', durationMs: performance.now() - started, errorCode: 'READ_FAILED' }), sensitive: 0 };
  }
}

async function defaultReadFile(filePath, maxBytes) {
  const content = await readFileFromDisk(filePath);
  return content.subarray(0, maxBytes).toString('utf8');
}

function timeoutBranch() {
  return branch({ status: 'timeout', durationMs: OVERALL_TIMEOUT_MS, truncated: true, errorCode: 'TIMEOUT' });
}

function enforceFinalCap(output) {
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') <= MAX_FINAL_BYTES) return output;
  for (const value of Object.values(output.branches)) {
    value.items = value.items.slice(0, 4).map((entry) => ({ ...entry, excerpt: clip(entry.excerpt, 256).text }));
    value.truncated = true;
  }
  output.truncated = true;
  return output;
}

export async function collectContext(input, overrides = {}) {
  const context = validateContextInput(input);
  const capabilities = overrides.capabilities ?? await detectCapabilities(context.cwd);
  const dependencies = {
    capabilities,
    runCommand: overrides.runCommand ?? spawnCommand,
    readFile: overrides.readFile ?? defaultReadFile
  };
  const overallTimeoutMs = overrides.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
  const controller = new AbortController();
  const started = performance.now();
  const states = {};
  let sensitiveFilesSkipped = 0;
  const jobs = {
    wiki: collectWiki(context, dependencies, controller.signal),
    repository: collectRepository(context, dependencies, controller.signal),
    git: collectGit(context, dependencies, controller.signal),
    entries: collectEntries(context, dependencies, controller.signal)
  };
  const tracked = Object.entries(jobs).map(([name, promise]) => Promise.resolve(promise).then((value) => {
    if (name === 'entries') {
      states.entries = value.result;
      sensitiveFilesSkipped += value.sensitive;
    } else states[name] = value;
  }).catch(() => { states[name] = branch({ status: 'failed', errorCode: 'COMMAND_FAILED' }); }));
  let timedOut = false;
  let deadline;
  await Promise.race([
    Promise.allSettled(tracked),
    new Promise((resolve) => {
      deadline = setTimeout(() => { timedOut = true; controller.abort(); resolve(); }, overallTimeoutMs);
    })
  ]);
  clearTimeout(deadline);
  for (const name of ['wiki', 'repository', 'git', 'entries']) {
    if (!states[name]) states[name] = timeoutBranch();
  }
  const output = {
    schema_version: SCHEMA_VERSION,
    query: context.query,
    branches: { wiki: states.wiki, repository: states.repository, git: states.git, entries: states.entries },
    sensitive_files_skipped: sensitiveFilesSkipped,
    total_duration_ms: Math.round(performance.now() - started),
    truncated: timedOut || Object.values(states).some((value) => value.truncated)
  };
  return enforceFinalCap(output);
}

async function runCli() {
  if (process.argv.length !== 2) {
    console.error('collect-context.mjs accepts JSON on stdin only');
    process.exit(64);
  }
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  process.stdout.write(`${JSON.stringify(await collectContext(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(64);
  });
}
