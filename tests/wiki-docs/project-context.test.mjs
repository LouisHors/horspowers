import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectContext } from '../../lib/context-collector.mjs';
import { resolveProjectContext } from '../../lib/project-context.mjs';

const ROOT = '/retained-fixture/project';
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

function companyIdentity() {
  return {
    kind: 'company',
    project_root: ROOT,
    project_fingerprint: FINGERPRINT
  };
}

function localIdentity() {
  return { kind: 'external', project_root: ROOT };
}

function wikiConfig({ enabled = true, autoSubmit = true } = {}) {
  return {
    schema_version: 1,
    project_id: 'ugnas/ugcli-lib',
    project_fingerprint: FINGERPRINT,
    development_mode: 'team',
    branch_strategy: 'worktree',
    testing_strategy: 'tdd',
    completion_strategy: 'pr',
    documentation: {
      enabled,
      backend: 'wiki',
      collection: 'my-code-wiki',
      root_uri: 'qmd://my-code-wiki/projects/ugcli-lib',
      manifest_uri: 'qmd://my-code-wiki/projects/ugcli-lib/index.md',
      submission: {
        mode: 'inbox-only',
        auto_submit: autoSubmit
      }
    }
  };
}

function localConfig({ enabled = true } = {}) {
  return {
    version: '4.5.0',
    development_mode: 'team',
    branch_strategy: 'worktree',
    testing_strategy: 'tdd',
    completion_strategy: 'pr',
    documentation: { enabled }
  };
}

function baseDependencies({ identity = localIdentity(), local = null, wiki = null } = {}) {
  return {
    resolveProjectRoot: async () => ROOT,
    identifyGitProject: async () => identity,
    defaultHostConfigPath: () => '/retained-fixture/home/.config/horspowers/host.json',
    readHostConfig: async () => ({ ok: true, config: { wiki: { collection: 'my-code-wiki' } } }),
    createQmdClient: () => ({ getExact: async () => ({ ok: false }) }),
    resolveWikiProjectConfig: async () => {
      const result = wiki ?? { status: 'wiki_unavailable' };
      if (result?.status !== 'ready' || result.config_uri) return result;
      return {
        ...result,
        config_uri: 'qmd://my-code-wiki/projects/ugcli-lib/horspowers-config.md'
      };
    },
    readConfigAtRoot: () => local
  };
}

test('uses a valid Wiki configuration for a company project even when a local config exists', async () => {
  let localReads = 0;
  const dependencies = baseDependencies({
    identity: companyIdentity(),
    local: localConfig(),
    wiki: { status: 'ready', config: wikiConfig(), config_revision: 3 }
  });
  dependencies.readConfigAtRoot = () => {
    localReads += 1;
    return localConfig();
  };

  const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

  assert.equal(context.status, 'ready');
  assert.equal(context.project.kind, 'company');
  assert.equal(context.identity_status, 'company');
  assert.equal(context.project.project_id, 'ugnas/ugcli-lib');
  assert.equal(context.project.project_fingerprint, FINGERPRINT);
  assert.equal(context.config.source, 'wiki');
  assert.equal(context.documentation.backend, 'wiki');
  assert.equal(context.documentation.auto_submit, true);
  assert.equal(Object.hasOwn(context, 'wiki_root'), false);
  assert.equal(Object.hasOwn(context, 'wiki_root_trusted'), false);
  assert.equal(localReads, 0);
});

test('retains verified Wiki transport metadata internally for the document runtime', async () => {
  const qmdClient = { getExact: async () => ({ ok: false }) };
  const manifest = { schema_version: 1, project_id: 'ugnas/ugcli-lib', documents: {} };
  const hostConfig = {
    wiki: {
      collection: 'my-code-wiki',
      inbox: {
        command: '/retained-fixture/wiki-inbox-submit',
        timeout_ms: 1_000,
        max_payload_bytes: 256 * 1024
      }
    }
  };
  const dependencies = baseDependencies({
    identity: companyIdentity(),
    wiki: {
      status: 'ready',
      config: wikiConfig(),
      config_uri: 'qmd://my-code-wiki/projects/ugcli-lib/horspowers-config.md',
      config_revision: 3,
      manifest
    }
  });
  dependencies.readHostConfig = async () => ({ ok: true, config: hostConfig });
  dependencies.createQmdClient = () => qmdClient;

  const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

  assert.equal(context.status, 'ready');
  assert.equal(context.wiki.config_uri, 'qmd://my-code-wiki/projects/ugcli-lib/horspowers-config.md');
  assert.equal(context.wiki.host_config, hostConfig);
  assert.equal(context.wiki.qmd_client, qmdClient);
  assert.equal(context.wiki.manifest, manifest);
  assert.equal(context.manifest_hash, createHash('sha256').update(JSON.stringify(context.wiki.manifest), 'utf8').digest('hex'));
  assert.match(context.host_config_digest, /^[0-9a-f]{64}$/u);
  assert.match(context.transport_digest, /^[0-9a-f]{64}$/u);
});

test('fails closed for a company Wiki error instead of reading an existing local configuration', async () => {
  let localReads = 0;
  const dependencies = baseDependencies({
    identity: companyIdentity(),
    local: localConfig(),
    wiki: { status: 'project_config_invalid' }
  });
  dependencies.readConfigAtRoot = () => {
    localReads += 1;
    return localConfig();
  };

  const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

  assert.equal(context.status, 'project_config_invalid');
  assert.equal(context.config.source, 'none');
  assert.equal(context.config.value, null);
  assert.equal(context.documentation.backend, 'disabled');
  assert.equal(context.documentation.auto_submit, false);
  assert.equal(localReads, 0);
});

test('closes the qmd client when company Wiki resolution fails', async () => {
  let closed = 0;
  const dependencies = baseDependencies({
    identity: companyIdentity(),
    wiki: { status: 'wiki_unavailable', error_code: 'qmd_get_failed' }
  });
  dependencies.createQmdClient = () => ({ close: async () => { closed += 1; } });

  const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

  assert.equal(context.status, 'wiki_unavailable');
  assert.equal(closed, 1);
});

test('qmd cleanup failure cannot replace a company Wiki resolution error', async () => {
  const dependencies = baseDependencies({
    identity: companyIdentity(),
    wiki: { status: 'wiki_unavailable', error_code: 'qmd_get_failed' }
  });
  dependencies.createQmdClient = () => ({ close: async () => { throw new Error('cleanup failed'); } });

  const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

  assert.equal(context.status, 'wiki_unavailable');
  assert.equal(context.error_code, 'qmd_get_failed');
});

test('qmd cleanup failure cannot replace missing Wiki runtime metadata', async () => {
  const dependencies = baseDependencies({
    identity: companyIdentity(),
    wiki: { status: 'ready', config: wikiConfig() }
  });
  dependencies.createQmdClient = () => ({ close: async () => { throw new Error('cleanup failed'); } });
  dependencies.resolveWikiProjectConfig = async () => ({ status: 'ready', config: wikiConfig() });

  const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

  assert.equal(context.status, 'wiki_unavailable');
  assert.equal(context.error_code, 'wiki_runtime_metadata_unavailable');
});

test('uses readConfigAtRoot for an ordinary remote and preserves local documentation mode', async () => {
  let localReads = 0;
  const dependencies = baseDependencies({ identity: localIdentity(), local: localConfig() });
  dependencies.readConfigAtRoot = (root) => {
    localReads += 1;
    assert.equal(root, ROOT);
    return localConfig();
  };

  const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

  assert.equal(context.status, 'ready');
  assert.equal(context.project.kind, 'local');
  assert.equal(context.identity_status, 'external');
  assert.equal(context.config.source, 'local');
  assert.deepEqual(context.config.value, localConfig());
  assert.equal(context.documentation.backend, 'local');
  assert.equal(context.documentation.auto_submit, false);
  assert.equal(localReads, 1);
});

test('derives a canonical trusted personal Wiki root only from validated production host config', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'horspowers-trusted-wiki-'));
  const homeDir = path.join(fixtureRoot, 'home');
  const actualWikiRoot = path.join(fixtureRoot, 'personal-wiki');
  const configuredWikiRoot = path.join(fixtureRoot, 'personal-wiki-link');
  await mkdir(path.join(homeDir, '.config', 'horspowers'), { recursive: true });
  await mkdir(path.join(actualWikiRoot, 'wiki'), { recursive: true });
  await writeFile(path.join(actualWikiRoot, 'wiki', 'index.md'), '# Wiki index\n', 'utf8');
  await writeFile(path.join(actualWikiRoot, 'wiki', 'production-fallback.md'), 'production fallback marker\n', 'utf8');
  await symlink(actualWikiRoot, configuredWikiRoot);
  await writeFile(path.join(homeDir, '.config', 'horspowers', 'host.json'), JSON.stringify({
    schema_version: 1,
    wiki: {
      transport: { kind: 'ssh-stdio-mcp', ssh_alias: 'localwiki', timeout_ms: 20_000, max_response_bytes: 262_144 },
      collection: 'my-code-wiki',
      registry_uri: 'qmd://my-code-wiki/projects/horspowers-registry.md',
      inbox: { command: '/retained-fixture/wiki-inbox-submit', timeout_ms: 20_000, max_payload_bytes: 262_144 },
      local_root: configuredWikiRoot
    }
  }), 'utf8');

  const context = await resolveProjectContext({
    cwd: ROOT,
    homeDir,
    dependencies: {
      resolveProjectRoot: async () => ROOT,
      identifyGitProject: async () => localIdentity(),
      readConfigAtRoot: () => localConfig(),
      classifyConfigAtRoot: () => 'valid'
    },
    // A request-shaped field must not participate in trust production.
    wiki_root: '/request-controlled/wiki'
  });

  assert.equal(context.status, 'ready');
  assert.equal(context.wiki_root, await realpath(actualWikiRoot));
  assert.equal(context.wiki_root_trusted, true);
  assert.deepEqual(context.wiki_root_provenance, {
    source: 'validated_host_config',
    field: 'wiki.local_root',
    collection: 'my-code-wiki',
    canonical: true
  });

  const collected = await collectContext({
    schema_version: 1,
    cwd: ROOT,
    query: 'production fallback marker',
    wiki_root: context.wiki_root,
    known_entry_files: []
  }, {
    resolveRuntime: async () => context,
    capabilities: { rg: false, qmd: false, git: false, grepExcludeDir: true, untracked: false }
  });
  assert.equal(collected.branches.wiki.status, 'ok');
  assert.equal(collected.branches.wiki.tool, 'grep -RIn');
  assert.equal(collected.branches.wiki.items.some((item) => item.excerpt.includes('production fallback marker')), true);
});

test('does not produce trusted Wiki facts for disabled personal documentation', async () => {
  const dependencies = baseDependencies({ identity: localIdentity(), local: localConfig({ enabled: false }) });
  dependencies.readHostConfig = async () => ({
    ok: true,
    config: { wiki: { collection: 'my-code-wiki', local_root: '/request-controlled/wiki' } }
  });
  dependencies.resolveTrustedWikiRoot = async () => ({
    wiki_root: '/request-controlled/wiki', wiki_root_trusted: true
  });

  const context = await resolveProjectContext({ cwd: ROOT, dependencies });

  assert.equal(Object.hasOwn(context, 'wiki_root'), false);
  assert.equal(Object.hasOwn(context, 'wiki_root_trusted'), false);
});

test('never reads local configuration for no-remote or ambiguous company identities', async () => {
  for (const identity of [
    { kind: 'none', project_root: ROOT },
    { kind: 'ambiguous_company_remote', project_root: ROOT, candidates: ['ugnas-gitlab/a', 'ugnas-gitlab/b'] }
  ]) {
    let localReads = 0;
    const dependencies = baseDependencies({ identity, local: localConfig() });
    dependencies.readConfigAtRoot = () => {
      localReads += 1;
      return localConfig();
    };

    const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

    assert.notEqual(context.status, 'ready');
    assert.equal(context.config.source, 'none');
    assert.equal(context.documentation.backend, 'disabled');
    assert.equal(Object.hasOwn(context, 'wiki_root'), false);
    assert.equal(Object.hasOwn(context, 'wiki_root_trusted'), false);
    assert.equal(localReads, 0);
  }
});

test('turns disabled documentation into a disabled backend and false auto-submit', async () => {
  const wikiDependencies = baseDependencies({
    identity: companyIdentity(),
    wiki: { status: 'ready', config: wikiConfig({ enabled: false, autoSubmit: true }) }
  });
  const wikiContext = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies: wikiDependencies });
  assert.equal(wikiContext.status, 'ready');
  assert.equal(wikiContext.documentation.enabled, false);
  assert.equal(wikiContext.documentation.backend, 'disabled');
  assert.equal(wikiContext.documentation.auto_submit, false);

  const localDependencies = baseDependencies({ identity: localIdentity(), local: localConfig({ enabled: false }) });
  const localContext = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies: localDependencies });
  assert.equal(localContext.documentation.enabled, false);
  assert.equal(localContext.documentation.backend, 'disabled');
  assert.equal(localContext.documentation.auto_submit, false);
});
