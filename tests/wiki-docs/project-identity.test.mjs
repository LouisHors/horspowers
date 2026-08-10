import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  classifyRepositoryRemotes,
  identifyGitProject,
  normalizeRemoteUrl
} from '../../lib/project-identity.mjs';

const execFileAsync = promisify(execFile);

const SAME_REPOSITORY = [
  'git@gitlab.ugnas.com:platform/ugcli-lib.git',
  'ssh://git@gitlab.ugnas.com/platform/ugcli-lib.git',
  'https://gitlab.ugnas.com/platform/ugcli-lib.git',
  'git@192.168.75.113:platform/ugcli-lib.git',
  'ssh://git@192.168.75.113:2222/platform/ugcli-lib.git'
];

test('normalizes domain, IP, SSH and HTTPS clones to one company repository', () => {
  const identities = SAME_REPOSITORY.map((url) =>
    classifyRepositoryRemotes([{ name: 'origin', url }])
  );

  assert.equal(new Set(identities.map((item) => item.project_fingerprint)).size, 1);
  assert.equal(identities[0].canonical_repository, 'ugnas-gitlab/platform/ugcli-lib');
});

test('normalizes SCP-style query and fragment clones to the SSH and HTTPS fingerprint', () => {
  const identities = [
    'git@gitlab.ugnas.com:platform/ugcli-lib.git?ref=main#readme',
    'ssh://git@gitlab.ugnas.com/platform/ugcli-lib.git?ref=main#readme',
    'https://gitlab.ugnas.com/platform/ugcli-lib.git?ref=main#readme'
  ].map((url) => classifyRepositoryRemotes([{ name: 'origin', url }]));

  assert.equal(new Set(identities.map((item) => item.project_fingerprint)).size, 1);
  assert.equal(identities[0].canonical_repository, 'ugnas-gitlab/platform/ugcli-lib');
});

test('requires exact trusted host matching', () => {
  for (const url of [
    'https://gitlab.ugnas.com.evil.example/platform/ugcli-lib.git',
    'https://192.168.75.113.example/platform/ugcli-lib.git'
  ]) {
    assert.equal(classifyRepositoryRemotes([{ name: 'origin', url }]).kind, 'external');
  }
});

test('rejects conflicting company remotes when origin cannot decide identity', () => {
  const result = classifyRepositoryRemotes([
    { name: 'upstream', url: 'git@gitlab.ugnas.com:a/one.git' },
    { name: 'backup', url: 'git@192.168.75.113:b/two.git' }
  ]);

  assert.equal(result.kind, 'ambiguous_company_remote');
});

test('normalizes a trusted host conservatively', () => {
  assert.deepEqual(
    normalizeRemoteUrl('SSH://git@GITLAB.UGNAS.COM.:2222/group/subgroup/repo.git.git'),
    {
      authority: 'ugnas-gitlab',
      host: 'gitlab.ugnas.com',
      normalized_path: 'group/subgroup/repo.git',
      canonical_repository: 'ugnas-gitlab/group/subgroup/repo.git'
    }
  );
});

test('classifies missing and malformed remotes without treating them as company projects', () => {
  assert.equal(classifyRepositoryRemotes([]).kind, 'none');
  assert.equal(classifyRepositoryRemotes([{ name: 'origin', url: 'not a remote' }]).kind, 'external');
});

test('fails closed when a trusted company host has no repository path', () => {
  for (const url of [
    'https://gitlab.ugnas.com/',
    'git@gitlab.ugnas.com:'
  ]) {
    const identity = classifyRepositoryRemotes([{ name: 'origin', url }]);
    assert.equal(identity.kind, 'ambiguous_company_remote', url);
  }

  assert.deepEqual(
    normalizeRemoteUrl('https://gitlab.ugnas.com/'),
    {
      authority: 'ugnas-gitlab',
      host: 'gitlab.ugnas.com',
      normalized_path: null,
      canonical_repository: null
    }
  );
});

test('fails closed when an incomplete trusted remote accompanies a valid company remote', () => {
  for (const incompleteOriginUrl of [
    'git@gitlab.ugnas.com:',
    'https://gitlab.ugnas.com/.git',
    'git@gitlab.ugnas.com:?ref=main#readme'
  ]) {
    const identity = classifyRepositoryRemotes([
      { name: 'origin', url: incompleteOriginUrl },
      { name: 'upstream', url: 'git@192.168.75.113:platform/ugcli-lib.git' }
    ]);

    assert.equal(identity.kind, 'ambiguous_company_remote', incompleteOriginUrl);
    assert.equal(identity.reason, 'trusted_company_host_missing_repository_path', incompleteOriginUrl);
    assert.deepEqual(identity.remote_names, ['origin'], incompleteOriginUrl);
  }
});

test('prefers a company origin over other company remotes', () => {
  const result = classifyRepositoryRemotes([
    { name: 'upstream', url: 'git@gitlab.ugnas.com:a/one.git' },
    { name: 'origin', url: 'git@192.168.75.113:b/two.git' }
  ]);

  assert.equal(result.kind, 'company');
  assert.equal(result.canonical_repository, 'ugnas-gitlab/b/two');
});

test('reads configured remotes through execFile without a shell', async () => {
  const calls = [];
  const identity = await identifyGitProject('/retained-fixture/company-project', {
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: 'remote.origin.url\tgit@gitlab.ugnas.com:platform/ugcli-lib.git\n' };
    }
  });

  assert.equal(identity.kind, 'company');
  assert.equal(identity.project_fingerprint, classifyRepositoryRemotes([{ name: 'origin', url: SAME_REPOSITORY[0] }]).project_fingerprint);
  assert.deepEqual(calls[0].args, ['-C', '/retained-fixture/company-project', 'config', '--local', '--get-regexp', '^remote\\..*\\.url$']);
  assert.equal(calls[0].file, 'git');
  assert.equal(calls[0].options.shell, false);
});

test('reads local remote names containing dots from Git config output', async () => {
  const identity = await identifyGitProject('/retained-fixture/dotted-remote-name', {
    execFile: async () => ({
      stdout: 'remote.origin.backup.url\tgit@gitlab.ugnas.com:platform/ugcli-lib.git\n'
    })
  });

  assert.equal(identity.kind, 'company');
  assert.equal(identity.remote_name, 'origin.backup');
  assert.equal(identity.canonical_repository, 'ugnas-gitlab/platform/ugcli-lib');
});

test('reads space-separated Git config output without truncating a dotted remote name', async () => {
  const identity = await identifyGitProject('/retained-fixture/space-separated-remote', {
    execFile: async () => ({
      stdout: 'remote.origin.backup.url git@gitlab.ugnas.com:platform/ugcli-lib.git\n'
    })
  });

  assert.equal(identity.kind, 'company');
  assert.equal(identity.remote_name, 'origin.backup');
  assert.equal(identity.canonical_repository, 'ugnas-gitlab/platform/ugcli-lib');
});

test('classifies actual local Git remotes with dotted names as company or ordinary projects', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'horspowers-project-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const companyProject = path.join(root, 'company-project');
  await execFileAsync('git', ['init', '--quiet', companyProject], { windowsHide: true });
  await execFileAsync('git', [
    '-C', companyProject, 'remote', 'add', 'origin.backup',
    'git@gitlab.ugnas.com:platform/ugcli-lib.git'
  ], { windowsHide: true });

  const ordinaryProject = path.join(root, 'ordinary-project');
  await execFileAsync('git', ['init', '--quiet', ordinaryProject], { windowsHide: true });
  await execFileAsync('git', [
    '-C', ordinaryProject, 'remote', 'add', 'upstream.cache',
    'https://github.com/example/ordinary-project.git'
  ], { windowsHide: true });

  const companyIdentity = await identifyGitProject(companyProject);
  const ordinaryIdentity = await identifyGitProject(ordinaryProject);

  assert.equal(companyIdentity.kind, 'company');
  assert.equal(companyIdentity.remote_name, 'origin.backup');
  assert.equal(companyIdentity.canonical_repository, 'ugnas-gitlab/platform/ugcli-lib');
  assert.equal(ordinaryIdentity.kind, 'external');
});

test('does not treat a global remote as a local project remote', async () => {
  const calls = [];
  const identity = await identifyGitProject('/retained-fixture/no-local-remote', {
    execFile: async (file, args, options) => {
      calls.push({ file, args, options });
      return {
        stdout: args.includes('--local')
          ? ''
          : 'remote.origin.url\thttps://github.com/example/global-only.git\n'
      };
    }
  });

  assert.equal(identity.kind, 'none');
  assert.deepEqual(calls[0].args, [
    '-C', '/retained-fixture/no-local-remote', 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'
  ]);
  assert.equal(calls[0].file, 'git');
  assert.equal(calls[0].options.shell, false);
});
