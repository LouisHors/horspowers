import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultHostConfigPath,
  readHostConfig,
  validateHostConfig
} from '../../lib/host-config.mjs';

function validHostConfig() {
  return {
    schema_version: 1,
    wiki: {
      transport: {
        kind: 'ssh-stdio-mcp',
        ssh_alias: 'localwiki',
        timeout_ms: 20_000,
        max_response_bytes: 262_144
      },
      collection: 'my-code-wiki',
      registry_uri: 'qmd://my-code-wiki/projects/horspowers-registry.md',
      inbox: {
        command: '/data/horsliu/bin/wiki-inbox-submit',
        timeout_ms: 20_000,
        max_payload_bytes: 262_144
      }
    }
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertInvalid(config, expectedPath) {
  const result = validateHostConfig(config);
  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'host_config_invalid');
  assert.ok(result.errors.some((error) => error.path === expectedPath), result.errors);
}

test('resolves the host-only configuration path without touching the filesystem', () => {
  assert.equal(
    defaultHostConfigPath('/Users/example'),
    path.join('/Users/example', '.config', 'horspowers', 'host.json')
  );
});

test('accepts the bounded SSH qmd host configuration', () => {
  const config = validHostConfig();
  const result = validateHostConfig(config);

  assert.equal(result.ok, true);
  assert.deepEqual(result.config, config);
});

test('rejects unknown fields at every configuration boundary', () => {
  const rootUnknown = validHostConfig();
  rootUnknown.unexpected = true;
  assertInvalid(rootUnknown, '$.unexpected');

  const wikiUnknown = validHostConfig();
  wikiUnknown.wiki.unexpected = true;
  assertInvalid(wikiUnknown, '$.wiki.unexpected');

  const transportUnknown = validHostConfig();
  transportUnknown.wiki.transport.unexpected = true;
  assertInvalid(transportUnknown, '$.wiki.transport.unexpected');

  const inboxUnknown = validHostConfig();
  inboxUnknown.wiki.inbox.unexpected = true;
  assertInvalid(inboxUnknown, '$.wiki.inbox.unexpected');
});

test('rejects unbounded or unsafe host transport values', () => {
  const cases = [
    {
      path: '$.wiki.inbox.command',
      mutate(config) { config.wiki.inbox.command = 'wiki-inbox-submit'; }
    },
    {
      path: '$.wiki.transport.ssh_alias',
      mutate(config) { config.wiki.transport.ssh_alias = 'local wiki;evil'; }
    },
    {
      path: '$.wiki.transport.ssh_alias',
      mutate(config) { config.wiki.transport.ssh_alias = '-Funsafe-ssh-config'; }
    },
    {
      path: '$.wiki.registry_uri',
      mutate(config) { config.wiki.registry_uri = 'https://my-code-wiki/projects/horspowers-registry.md'; }
    },
    {
      path: '$.wiki.registry_uri',
      mutate(config) { config.wiki.registry_uri = 'qmd://other-collection/projects/horspowers-registry.md'; }
    },
    {
      path: '$.wiki.transport.timeout_ms',
      mutate(config) { config.wiki.transport.timeout_ms = 999; }
    },
    {
      path: '$.wiki.transport.timeout_ms',
      mutate(config) { config.wiki.transport.timeout_ms = 120_001; }
    },
    {
      path: '$.wiki.inbox.timeout_ms',
      mutate(config) { config.wiki.inbox.timeout_ms = 999; }
    },
    {
      path: '$.wiki.inbox.timeout_ms',
      mutate(config) { config.wiki.inbox.timeout_ms = 120_001; }
    },
    {
      path: '$.wiki.transport.max_response_bytes',
      mutate(config) { config.wiki.transport.max_response_bytes = 262_145; }
    },
    {
      path: '$.wiki.inbox.max_payload_bytes',
      mutate(config) { config.wiki.inbox.max_payload_bytes = 262_145; }
    }
  ];

  for (const { path: expectedPath, mutate } of cases) {
    const config = clone(validHostConfig());
    mutate(config);
    assertInvalid(config, expectedPath);
  }
});

test('reads a valid explicit configuration file without changing it', async () => {
  const artifactDirectory = path.join(os.tmpdir(), `horspowers-host-config-${process.pid}-${Date.now()}`);
  await mkdir(artifactDirectory, { recursive: true });
  const configPath = path.join(artifactDirectory, 'host.json');
  const source = JSON.stringify(validHostConfig(), null, 2);
  await writeFile(configPath, source, 'utf8');

  const result = await readHostConfig(configPath);

  assert.equal(result.ok, true);
  assert.deepEqual(result.config, validHostConfig());
  assert.equal(await readFile(configPath, 'utf8'), source);
});

test('reports a missing host configuration without creating a file or parent directory', async () => {
  const absentDirectory = path.join(os.tmpdir(), `horspowers-host-config-missing-${process.pid}-${Date.now()}`);
  const configPath = path.join(absentDirectory, 'host.json');

  await assert.rejects(lstat(absentDirectory), { code: 'ENOENT' });
  const result = await readHostConfig(configPath);

  assert.equal(result.ok, false);
  assert.equal(result.error_code, 'host_config_missing');
  await assert.rejects(lstat(absentDirectory), { code: 'ENOENT' });
});
