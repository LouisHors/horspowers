import test from 'node:test';
import assert from 'node:assert/strict';

import { collectContext, validateContextInput } from '../../skills/brainstorming/scripts/collect-context.mjs';

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

function fakeDependencies({ capabilities, commands = {}, readFiles = {}, delayMs = 0 } = {}) {
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
});

test('uses trusted Wiki Markdown fallback when qmd is unavailable', async () => {
  const dependencies = fakeDependencies({
    capabilities: { git: true },
    commands: { grep: commandResult('/wiki/README.md:1:needle\n'), git: commandResult() }
  });
  const result = await collectContext(context({ wiki_root: '/wiki' }), dependencies);

  assert.equal(result.branches.wiki.tool, 'grep -RIn');
  assert.equal(result.branches.wiki.status, 'ok');
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

test('rejects invalid collector envelopes before starting commands', () => {
  assert.throws(() => validateContextInput(context({ cwd: 'relative/path' })), /absolute/i);
  assert.throws(() => validateContextInput(context({ query: 'x'.repeat(4097) })), /4 KiB/i);
  assert.throws(() => validateContextInput(context({ known_entry_files: ['/outside/readme.md'] })), /inside cwd/i);
});
