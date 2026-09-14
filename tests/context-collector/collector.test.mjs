import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectContext, validateContextInput } from '../../skills/brainstorming/scripts/collect-context.mjs';
import { collectContext as collectSharedContext, spawnCommand } from '../../lib/context-collector.mjs';

function context(overrides = {}) {
  return {
    schema_version: 1,
    cwd: '/repo',
    query: 'needle',
    wiki_root: null,
    known_entry_files: [],
    ...overrides
  };
}

function commandResult(stdout = '', options = {}) {
  return { code: 0, stdout, stderr: '', timed_out: false, truncated: false, ...options };
}

function fakeDependencies(options = {}) {
  const { capabilities, commands = {}, readFiles = {}, delayMs = 0, runtimeResult } = options;
  const hasRuntimeResult = Object.hasOwn(options, 'runtimeResult');
  const calls = [];
  return {
    calls,
    capabilities: {
      rg: false,
      qmd: false,
      git: false,
      grepExcludeDir: true,
      untracked: false,
      ...capabilities
    },
    runCommand: async ({ command, args, ...options }) => {
      calls.push({ command, args, ...options });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const key = `${command} ${args.join(' ')}`;
      const response = commands[key] ?? commands[command] ?? commandResult();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response({ command, args, ...options });
      return response;
    },
    resolveRuntime: async () => hasRuntimeResult ? runtimeResult : { status: 'ready', identity_status: 'external' },
    realpath: async (filePath) => filePath,
    readFile: async (filePath) => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!(filePath in readFiles)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
      return readFiles[filePath];
    }
  };
}

test('uses rg for repository text search when available', async () => {
  const dependencies = fakeDependencies({
    capabilities: { rg: true },
    commands: { rg: commandResult('README.md:2:needle\n') }
  });
  const result = await collectContext(context(), dependencies);

  assert.equal(result.branches.repository.tool, 'rg -n');
  assert.equal(dependencies.calls.some((call) => call.command === 'rg'), true);
});

test('falls back to git grep and then bounded grep for untracked files', async () => {
  const gitDependencies = fakeDependencies({
    capabilities: { git: true },
    commands: { git: commandResult('README.md:1:needle\n') }
  });
  const gitResult = await collectContext(context(), gitDependencies);
  assert.equal(gitResult.branches.repository.tool, 'git grep -n');

  const untrackedDependencies = fakeDependencies({
    capabilities: { git: true, untracked: true },
    commands: { grep: commandResult('README.md:1:needle\n'), git: commandResult() }
  });
  const untrackedResult = await collectContext(context(), untrackedDependencies);
  assert.equal(untrackedResult.branches.repository.tool, 'grep -RIn');
});

test('uses find-backed grep when neither rg nor Git are available', async () => {
  const dependencies = fakeDependencies({
    commands: { grep: commandResult('/repo/README.md:1:needle\n') }
  });
  const result = await collectContext(context(), dependencies);

  assert.equal(result.branches.repository.tool, 'grep -RIn');
});

test('enumerates files before grep when grep lacks exclude-dir support', async () => {
  const dependencies = fakeDependencies({
    capabilities: { git: true, untracked: true, grepExcludeDir: false },
    commands: {
      git: commandResult('README.md\nsrc/app.mjs\n'),
      grep: commandResult('README.md:1:needle\n')
    }
  });
  const result = await collectContext(context(), dependencies);

  assert.equal(result.branches.repository.tool, 'grep -n (enumerated)');
  assert.equal(dependencies.calls.some((call) => call.command === 'git' && call.args.includes('ls-files')), true);
  assert.equal(dependencies.calls.some((call) => call.command === 'git' && call.args.includes('-z')), true);
});

test('parses NUL-separated git file lists so non-ASCII paths stay unquoted', async () => {
  const nonAscii = 'docs/计划-中文.md';
  const expectedPath = path.join('/repo', nonAscii);
  const dependencies = fakeDependencies({
    capabilities: { git: true, untracked: true, grepExcludeDir: false },
    commands: {
      git: commandResult(`${nonAscii}\u0000src/app.mjs\u0000`),
      grep: (request) => {
        assert.equal(request.args.includes(expectedPath), true, request.args.join(' '));
        return commandResult('');
      }
    }
  });
  const result = await collectContext(context(), dependencies);

  assert.equal(result.branches.repository.tool, 'grep -n (enumerated)');
  assert.equal(result.branches.repository.status, 'ok');
});

test('real git enumeration keeps non-ASCII tracked paths usable without rg', async () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = await collectSharedContext(
    { schema_version: 1, cwd: repoRoot, query: 'zzz-hps-no-match-xyzzy', wiki_root: null, known_entry_files: [] },
    {
      resolveRuntime: async () => null,
      capabilities: { rg: false, qmd: false, git: true, grepExcludeDir: false, untracked: true },
      runCommand: spawnCommand
    }
  );

  assert.equal(result.branches.repository.tool, 'grep -n (enumerated)');
  assert.equal(result.branches.repository.status, 'ok');
});

test('uses trusted Wiki Markdown fallback when qmd is unavailable', async () => {
  const dependencies = fakeDependencies({
    capabilities: { git: true },
    runtimeResult: {
      status: 'ready', identity_status: 'external', wiki_root_trusted: true, wiki_root: '/wiki',
      wiki_root_provenance: {
        source: 'validated_host_config', field: 'wiki.local_root', collection: 'my-code-wiki', canonical: true
      }
    },
    commands: { grep: commandResult('/wiki/README.md:1:needle\n'), git: commandResult() }
  });
  const result = await collectContext(context({ wiki_root: '/wiki' }), dependencies);

  assert.equal(result.branches.wiki.tool, 'grep -RIn');
  assert.equal(result.branches.wiki.status, 'ok');
});

test('fails closed when wiki_root is not verified by the runtime', async () => {
  const dependencies = fakeDependencies({
    capabilities: { git: true },
    runtimeResult: { status: 'ready', identity_status: 'external' },
    commands: { grep: commandResult('/wiki/README.md:1:needle\n'), git: commandResult() }
  });
  const result = await collectContext(context({ wiki_root: '/wiki' }), dependencies);
  assert.equal(result.branches.wiki.status, 'skipped');
  assert.equal(result.branches.wiki.error_code, 'NO_TRUSTED_WIKI');
  assert.equal(dependencies.calls.some((call) => call.command === 'grep' && call.cwd === '/wiki'), false);
});

test('uses only the runtime canonical Wiki root when a request supplies a different root', async () => {
  const dependencies = fakeDependencies({
    capabilities: { git: true },
    runtimeResult: {
      status: 'ready', identity_status: 'external', wiki_root_trusted: true, wiki_root: '/verified/wiki',
      wiki_root_provenance: {
        source: 'validated_host_config', field: 'wiki.local_root', collection: 'my-code-wiki', canonical: true
      }
    },
    commands: { grep: commandResult('/verified/wiki/README.md:1:needle\n'), git: commandResult() }
  });
  const result = await collectContext(context({ wiki_root: '/request-controlled/wiki' }), dependencies);

  assert.equal(result.branches.wiki.status, 'ok');
  assert.equal(dependencies.calls.find((call) => call.command === 'grep' && call.args.includes('--include=*.md'))?.cwd, '/verified/wiki');
  assert.equal(dependencies.calls.some((call) => call.command === 'grep' && call.cwd === '/request-controlled/wiki'), false);
});

test('runs qmd query only after fewer than three unique search hits and retains search hits on query failure', async () => {
  const sparseDependencies = fakeDependencies({
    capabilities: { qmd: true },
    commands: {
      qmd: ({ args }) => args[0] === 'search'
        ? commandResult('qmd://wiki/a.md: A\nqmd://wiki/b.md: B\n')
        : commandResult('', { code: 1, stderr: 'query failed' })
    }
  });
  const sparseResult = await collectContext(context(), sparseDependencies);
  assert.equal(sparseDependencies.calls.filter((call) => call.command === 'qmd').length, 2);
  assert.equal(sparseResult.branches.wiki.items.length, 2);

  const fullDependencies = fakeDependencies({
    capabilities: { qmd: true },
    commands: { qmd: commandResult('qmd://wiki/a.md: A\nqmd://wiki/b.md: B\nqmd://wiki/c.md: C\n') }
  });
  await collectContext(context(), fullDependencies);
  assert.equal(fullDependencies.calls.filter((call) => call.command === 'qmd').length, 1);
});

test('does not invoke qmd or a local Wiki fallback unless the runtime itself identifies an external project', async () => {
  for (const runtimeResult of [
    { status: 'wiki_unavailable', identity_status: 'company' },
    { status: 'ambiguous_company_remote', identity_status: 'ambiguous_company_remote' },
    { status: 'unregistered_no_remote', identity_status: 'none' },
    null
  ]) {
    const dependencies = fakeDependencies({
      capabilities: { qmd: true, git: true },
      runtimeResult,
      commands: {
        qmd: commandResult('qmd://my-code-wiki/projects/other.md: unrelated\n'),
        git: commandResult('abc\t1\tcommit\n')
      }
    });

    const result = await collectContext(context({ wiki_root: '/wiki' }), dependencies);

    assert.equal(result.branches.wiki.status, 'skipped', JSON.stringify(runtimeResult));
    assert.equal(result.branches.wiki.error_code, 'DOCUMENT_RUNTIME_REQUIRED', JSON.stringify(runtimeResult));
    assert.equal(dependencies.calls.some((call) => call.command === 'qmd'), false, JSON.stringify(runtimeResult));
    assert.equal(dependencies.calls.some((call) => call.command === 'grep' && call.cwd === '/wiki'), false, JSON.stringify(runtimeResult));
  }
});

test('keeps other branches when one command branch fails', async () => {
  const dependencies = fakeDependencies({
    capabilities: { rg: true, git: true },
    commands: {
      rg: new Error('rg unavailable during run'),
      git: commandResult('abc\t1\tcommit subject\n')
    },
    readFiles: { '/repo/README.md': '# fixture\n' }
  });
  const result = await collectContext(context({ known_entry_files: ['/repo/README.md'] }), dependencies);

  assert.equal(result.branches.repository.status, 'failed');
  assert.equal(result.branches.git.status, 'ok');
  assert.equal(result.branches.entries.status, 'ok');
});

test('never reads sensitive known entries and records the skipped count', async () => {
  const dependencies = fakeDependencies({
    readFiles: {
      '/repo/README.md': '# allowed\n',
      '/repo/.env': 'SECRET=not-readable\n',
      '/repo/id_rsa': 'private-key\n'
    }
  });
  const result = await collectContext(context({
    known_entry_files: ['/repo/README.md', '/repo/.env', '/repo/id_rsa']
  }), dependencies);

  assert.equal(result.sensitive_files_skipped, 2);
  assert.deepEqual(result.branches.entries.items.map((item) => item.uri_or_path), ['/repo/README.md']);
});

test('never follows a known-entry symlink outside the canonical project root', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'horspowers-entry-containment-'));
  const projectRoot = path.join(fixtureRoot, 'project');
  const outsideFile = path.join(fixtureRoot, 'outside-sensitive.md');
  await mkdir(projectRoot);
  await writeFile(outsideFile, 'outside secret marker', 'utf8');
  const linkedEntry = path.join(projectRoot, 'README.md');
  await symlink(outsideFile, linkedEntry);

  const reads = [];
  const result = await collectSharedContext({
    schema_version: 1,
    cwd: projectRoot,
    query: 'outside secret marker',
    wiki_root: null,
    known_entry_files: [linkedEntry]
  }, {
    capabilities: { rg: false, qmd: false, git: false, grepExcludeDir: true, untracked: false },
    resolveRuntime: async () => ({ status: 'ready', identity_status: 'external' }),
    runCommand: async () => commandResult('', { code: 1 }),
    readFile: async (filePath) => {
      reads.push(filePath);
      return readFile(filePath, 'utf8');
    }
  });

  assert.equal(reads.includes(linkedEntry), false);
  assert.equal(result.branches.entries.items.some((entry) => entry.excerpt.includes('outside secret marker')), false);
});

test('starts all branches concurrently instead of serializing independent searches', async () => {
  const dependencies = fakeDependencies({
    capabilities: { rg: true, qmd: true, git: true },
    commands: { rg: commandResult('README.md:1:needle\n'), qmd: commandResult('qmd://wiki/a.md: A\nqmd://wiki/b.md: B\nqmd://wiki/c.md: C\n'), git: commandResult('abc\t1\tcommit\n') },
    readFiles: { '/repo/README.md': '# fixture\n' },
    delayMs: 100
  });
  const started = performance.now();
  const result = await collectContext(context({ known_entry_files: ['/repo/README.md'] }), dependencies);
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 240, `expected concurrency, received ${elapsed.toFixed(1)}ms`);
  assert.deepEqual(Object.keys(result.branches), ['wiki', 'repository', 'git', 'entries']);
});

test('returns bounded timeout output when the overall deadline expires', async () => {
  const dependencies = fakeDependencies({
    capabilities: { rg: true },
    commands: { rg: () => new Promise(() => {}) }
  });
  const result = await collectContext(context(), { ...dependencies, overallTimeoutMs: 20 });

  assert.equal(result.truncated, true);
  assert.equal(result.branches.repository.status, 'timeout');
  assert.ok(result.total_duration_ms < 200);
});

test('an already-aborted external signal prevents runtime resolution, capability probes, and commands', async () => {
  const controller = new AbortController();
  controller.abort();
  let resolveCalls = 0;
  let commandCalls = 0;
  const result = await collectSharedContext(context(), {
    signal: controller.signal,
    resolveRuntime: async () => { resolveCalls += 1; return { status: 'ready', identity_status: 'external' }; },
    runCommand: async () => { commandCalls += 1; return commandResult(); },
    overallTimeoutMs: 1_000
  });

  assert.equal(resolveCalls, 0);
  assert.equal(commandCalls, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.branches.repository.status, 'timeout');
});

test('a running external abort reaches child commands and returns a bounded timeout envelope', async () => {
  const controller = new AbortController();
  let commandSignal;
  let commandStarted;
  const started = new Promise((resolve) => { commandStarted = resolve; });
  const dependencies = {
    capabilities: { rg: true, qmd: false, git: false, grepExcludeDir: true, untracked: false },
    resolveRuntime: async () => ({ status: 'ready', identity_status: 'external' }),
    runCommand: async ({ signal }) => {
      commandSignal = signal;
      commandStarted();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return commandResult('', { code: 1, timed_out: true, truncated: true });
    },
    realpath: async (filePath) => filePath,
    readFile: async () => ''
  };
  const startedAt = performance.now();
  const resultPromise = collectSharedContext(context(), {
    ...dependencies,
    signal: controller.signal,
    overallTimeoutMs: 1_000
  });

  await started;
  controller.abort();
  const result = await resultPromise;

  assert.ok(performance.now() - startedAt < 500, 'external abort should not wait for the internal deadline');
  assert.equal(commandSignal?.aborted, true);
  assert.equal(result.truncated, true);
  assert.equal(result.branches.repository.status, 'timeout');
});

test('removes the external abort listener after collection settles', async () => {
  const external = new EventTarget();
  let adds = 0;
  let removes = 0;
  const addEventListener = external.addEventListener.bind(external);
  const removeEventListener = external.removeEventListener.bind(external);
  external.addEventListener = (...args) => { adds += 1; return addEventListener(...args); };
  external.removeEventListener = (...args) => { removes += 1; return removeEventListener(...args); };

  await collectSharedContext(context(), {
    signal: external,
    capabilities: { rg: false, qmd: false, git: false, grepExcludeDir: true, untracked: false },
    resolveRuntime: async () => ({ status: 'ready', identity_status: 'external' }),
    realpath: async (filePath) => filePath,
    readFile: async () => ''
  });

  assert.equal(adds, 1);
  assert.equal(removes, 1);
});

test('includes runtime resolution in the overall timeout boundary', async () => {
  const dependencies = fakeDependencies({ capabilities: { rg: true } });
  dependencies.resolveRuntime = async () => new Promise(() => {});
  const started = performance.now();
  const result = await collectContext(context(), { ...dependencies, overallTimeoutMs: 20 });
  const elapsed = performance.now() - started;

  assert.ok(elapsed < 200, `expected runtime resolve deadline, received ${elapsed.toFixed(1)}ms`);
  assert.equal(result.truncated, true);
  assert.equal(result.branches.wiki.status, 'skipped');
  assert.equal(result.branches.wiki.error_code, 'DOCUMENT_RUNTIME_REQUIRED');
  assert.equal(result.branches.repository.status, 'timeout');
  assert.equal(dependencies.calls.length, 0);
});

test('closes a qmd client returned after the runtime deadline and propagates abort', async () => {
  let release;
  let signalSeen = null;
  let closed = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const dependencies = fakeDependencies({ capabilities: { rg: true } });
  dependencies.resolveRuntime = async (_cwd, signal) => {
    signalSeen = signal;
    await gate;
    return {
      status: 'ready',
      identity_status: 'company',
      wiki: { qmd_client: { close: async () => { closed += 1; } } }
    };
  };

  const resultPromise = collectContext(context(), { ...dependencies, overallTimeoutMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 35));
  const result = await resultPromise;

  assert.equal(result.truncated, true);
  assert.equal(result.branches.repository.status, 'timeout');
  assert.equal(signalSeen?.aborted, true);
  assert.equal(closed, 0);

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(closed, 1);
});

test('rejects invalid collector envelopes before starting commands', () => {
  assert.throws(() => validateContextInput(context({ cwd: 'relative/path' })), /absolute/i);
  assert.throws(() => validateContextInput(context({ query: 'x'.repeat(4097) })), /4 KiB/i);
  assert.throws(() => validateContextInput({ ...context(), wiki_mode: 'global-search' }), /fields/i);
  assert.throws(() => validateContextInput(context({ known_entry_files: ['/outside/readme.md'] })), /inside cwd/i);
});

test('rejects unsafe wiki roots and entry path carriers at the collector boundary', () => {
  for (const input of [
    context({ wiki_root: '/wiki;touch /tmp/pwned' }),
    context({ wiki_root: '/repo/../outside' }),
    context({ known_entry_files: ['/repo/README.md\nnext'] })
  ]) {
    assert.throws(() => validateContextInput(input), /safe absolute|inside cwd|wiki_root/iu);
  }
});

test('shared collector resolves runtime exactly once before parallel branches', async () => {
  let resolveCalls = 0;
  const dependencies = fakeDependencies({
    capabilities: { rg: true, git: true },
    commands: {
      rg: commandResult('README.md:1:needle\\n'),
      git: commandResult('abc\\t1\\tcommit\\n')
    }
  });
  dependencies.resolveRuntime = async () => {
    resolveCalls += 1;
    return { status: 'ready', identity_status: 'external' };
  };

  const result = await collectSharedContext(context(), dependencies);

  assert.equal(resolveCalls, 1);
  assert.equal(result.branches.repository.status, 'ok');
});
