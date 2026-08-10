import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRepositoryRemotes,
  identifyGitProject,
  normalizeRemoteUrl
} from '../../lib/project-identity.mjs';

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
  assert.equal(classifyRepositoryRemotes([{ name: 'origin', url: 'https://gitlab.ugnas.com/' }]).kind, 'external');
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
  assert.deepEqual(calls[0].args, ['-C', '/retained-fixture/company-project', 'config', '--get-regexp', '^remote\\..*\\.url$']);
  assert.equal(calls[0].file, 'git');
  assert.equal(calls[0].options.shell, false);
});
