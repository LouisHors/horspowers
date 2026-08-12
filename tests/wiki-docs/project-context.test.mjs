import assert from 'node:assert/strict';
import test from 'node:test';

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
  assert.equal(context.project.project_id, 'ugnas/ugcli-lib');
  assert.equal(context.project.project_fingerprint, FINGERPRINT);
  assert.equal(context.config.source, 'wiki');
  assert.equal(context.documentation.backend, 'wiki');
  assert.equal(context.documentation.auto_submit, true);
  assert.equal(localReads, 0);
});

test('retains verified Wiki transport metadata internally for the document runtime', async () => {
  const qmdClient = { getExact: async () => ({ ok: false }) };
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
      config_revision: 3
    }
  });
  dependencies.readHostConfig = async () => ({ ok: true, config: hostConfig });
  dependencies.createQmdClient = () => qmdClient;

  const context = await resolveProjectContext({ cwd: ROOT, homeDir: '/retained-fixture/home', dependencies });

  assert.equal(context.status, 'ready');
  assert.equal(context.wiki.config_uri, 'qmd://my-code-wiki/projects/ugcli-lib/horspowers-config.md');
  assert.equal(context.wiki.host_config, hostConfig);
  assert.equal(context.wiki.qmd_client, qmdClient);
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
  assert.equal(context.config.source, 'local');
  assert.deepEqual(context.config.value, localConfig());
  assert.equal(context.documentation.backend, 'local');
  assert.equal(context.documentation.auto_submit, false);
  assert.equal(localReads, 1);
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
