import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  InboxSubmitter,
  createSubmissionId,
  filenameForSubmission,
  renderInboxSubmission
} from '../../lib/inbox-submitter.mjs';

const LOW_ENTROPY_IDENTIFIER_PADDING = 'a'.repeat(40);
const OPAQUE_IDENTIFIER_SEGMENTS = ['abcdefghij', 'klmnopqrst', 'uvwxyz012345'];
const INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('a'.repeat(12));
const SHORT_INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('a'.repeat(7));
const REPEATED_NON_PERIODIC_INTERLEAVED_OPAQUE_IDENTIFIER =
  ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('000000010');
const SHORTER_INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7', 'g9h2j4', 'm6n8p0', 'r2s4t6'].join('a'.repeat(5));
const VARIED_TERNARY_INTERLEAVED_OPAQUE_IDENTIFIER = [
  'a3d5e7f', 'aaabacaaabcb', 'g9h2j4k', 'aacaabaaacbc', 'm6n8p0q', 'abaacaaaabcb', 'r2s4t6u'
].join('');
const LOW_ENTROPY_SHORT_CHUNK_INTERLEAVED_IDENTIFIER = ['abcde', 'fghij', 'klmno', 'pqrst', 'uvwxy'].join('a'.repeat(7));
const REPEATED_OPAQUE_IDENTIFIER = ['a3d5e7fg9h2j', 'a'.repeat(10), 'a3d5e7fg9h2j', 'a'.repeat(10), 'a3d5e7fg9h2j'].join('');
const PAIRED_OPAQUE_IDENTIFIER = 'aabbccddeeffgghhiijjkkllmmnnooppqqrrsstt';
const LOWERCASE_OPAQUE_IDENTIFIER = 'qwertyuiopasdfghjklz';
const SINGLE_CHARACTER_INTERLEAVED_LOWERCASE_OPAQUE_IDENTIFIER = LOWERCASE_OPAQUE_IDENTIFIER
  .split('').map(character => `${character}a`).join('');
const SHORT_SEGMENTED_OPAQUE_IDENTIFIER = ['abcd', 'efgh', 'ijkl', 'mnop', 'qrst', 'uvwx', 'yz01'].join('-');
const PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER = ['potib', 'kruhe', 'xafiz', 'uneba', 'jerex', 'itypu', 'povwf'].join('-');
const VARIABLE_PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER =
  'potib-kruhex-afizun-eba-jerexx-itypu-povwfa';
const NEARLY_REPEATED_LOW_ENTROPY_INTERLEAVED_IDENTIFIER = 'qweraabbcty1uaabbcioplaabbcsdfgaabbchjkl';
const TWO_PADDING_ONE_OPAQUE_INTERLEAVED_IDENTIFIER = ['qwertyu', 'a'.repeat(5), 'iop1asd', 'a'.repeat(5), 'fghjklz'].join('');
const HYPHEN_SPLIT_LOWERCASE_OPAQUE_IDENTIFIER = 'kzqvmp-jdthra-xlyfecwb';
const THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER = ['c3d5', 'e7f9', 'g2h4', 'j6k8', 'l0m1', 'n3p5', 'q7r9', 's2t4'].join('aaa');
const DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER = [
  'a3', 'd5', 'e7', 'fg', '9h', '2j', '4k', 'm6', 'n8', 'p0', 'qr', '2s', '4t', '6u'
].join('aba');
const DENSE_FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER = 'a3d5e7fg9h2j4km6n8p0qr2s4t6u'.split('').join('abca');
const DISTINCT_DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER = (() => {
  const core = 'a3d5e7fg9h2j4km6n8p0';
  const padding = [];
  for (const first of ['a', 'b', 'c']) {
    for (const second of ['a', 'b', 'c']) {
      for (const third of ['a', 'b', 'c']) padding.push(`${first}${second}${third}`);
    }
  }
  return core.split('').map((character, index) => `${character}${padding[index] ?? ''}`).join('');
})();
const FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER = 'c3d5aaabe7f9aaabg2h4aaabj6k8aaabl0m1aaabn3p5aaabq7r9aaabs2t4';
const TWO_SINGLETON_PADDING_OPAQUE_IDENTIFIER = 'qweraaabcty1uaaabcioplaaabcsdfgaaabchjkl';
const DISTINCT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER = 'a3d5e7fcacccabbcabcg9h2j4kbaaabccacbcam6n8p0qaccbccbbbacbr2s4t6u';
const DISTINCT_SHORT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER = '3at83u9aabbacb83u50nicacaacaba54zilcnabbbcccaayx8bupk';
const DISTINCT_ADJACENT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER = 'cra98z2cbba5cr29cfcbacaaccaababi9k7udscccacbbbacaccvat0r6x';
const OPAQUE_IDENTIFIER_CORE = 'a3d5e7fg9h2j4km6n8p0';
const LONG_PERIODIC_PADDING_OPAQUE_IDENTIFIER = OPAQUE_IDENTIFIER_CORE.match(/.{1,3}/gu).join('aabbaabbaa');
const EIGHT_CHARACTER_PADDING_OPAQUE_IDENTIFIER = OPAQUE_IDENTIFIER_CORE.match(/.{1,3}/gu).join('abcdabcd');
const LONG_PERIODIC_PADDING_PROJECT_IDENTIFIER = `group/${OPAQUE_IDENTIFIER_CORE.match(/.{1,2}/gu).join('000000010')}`;
const DECIMAL_CHARACTER_CODE_OPAQUE_IDENTIFIER = OPAQUE_IDENTIFIER_CORE
  .split('').map(character => `x${character.charCodeAt(0).toString().padStart(3, '0')}`).join('');
const FULLWIDTH_OPAQUE_PROJECT_IDENTIFIER = `fixture/${OPAQUE_IDENTIFIER_CORE.replace(/[a-z0-9]/gu, (character) =>
  String.fromCodePoint(character >= '0' && character <= '9'
    ? 0xff10 + Number(character)
    : 0xff41 + character.charCodeAt(0) - 'a'.charCodeAt(0)))}`;
const SEMANTIC_LOOKING_OPAQUE_IDENTIFIER = 'ther-inat-onre-comel-iquve';
const NESTED_READABLE_PROJECT_ID = 'platform/service/authorization-configuration-observability';

function metadata(operation = 'create') {
  return {
    schema_version: 1,
    submission_id: createSubmissionId(),
    source: 'Ugreen-jump-base',
    project_id: 'ugnas/ugcli-lib',
    project_fingerprint: `sha256:${'a'.repeat(64)}`,
    document_type: operation === 'config-change' ? 'config' : 'task',
    logical_id: operation === 'config-change' ? 'horspowers-config' : 'runtime-fixture',
    operation,
    base_revision: operation === 'create' ? 0 : 2,
    proposed_revision: operation === 'create' ? 1 : 3,
    status: 'pending-review'
  };
}

function fakeSpawn({ mode = 'success', output = '', errorOutput = '' } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const received = [];
    let endCalls = 0;
    let drained = false;
    let endBeforeDrain = false;
    const originalEnd = stdin.end.bind(stdin);
    const originalWrite = stdin.write.bind(stdin);
    stdin.end = (...argsToEnd) => {
      endCalls += 1;
      if (mode === 'backpressure' && !drained) endBeforeDrain = true;
      return originalEnd(...argsToEnd);
    };
    stdin.write = (...argsToWrite) => {
      const result = originalWrite(...argsToWrite);
      if (mode === 'backpressure') {
        queueMicrotask(() => {
          drained = true;
          stdin.emit('drain');
        });
        return false;
      }
      return result;
    };
    stdin.on('data', chunk => received.push(Buffer.from(chunk)));
    stdin.once('finish', () => {
      if (mode === 'timeout') return;
      queueMicrotask(() => {
        if (mode === 'stdout-large') stdout.write('x'.repeat(300 * 1024));
        else if (output) stdout.write(output);
        if (mode === 'stderr-large') stderr.write('x'.repeat(300 * 1024));
        else if (errorOutput) stderr.write(errorOutput);
        child.emit('close', mode === 'nonzero' ? 23 : 0);
      });
    });
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {
      queueMicrotask(() => child.emit('close', null));
      return true;
    };
    calls.push({
      command,
      args,
      options,
      received,
      get endCalls() { return endCalls; },
      get endBeforeDrain() { return endBeforeDrain; }
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('renders one metadata block and submits its complete UTF-8 payload only through stdin', async () => {
  const entry = metadata('create');
  const payload = renderInboxSubmission({
    metadata: entry,
    proposedDocument: '# Proposed document\n\nA structured proposal.\n'
  });
  const fake = fakeSpawn();
  const submitter = new InboxSubmitter({
    command: '/retained-fixture/wiki-inbox-submit', timeoutMs: 1000, maxPayloadBytes: 256 * 1024
  }, { spawnImpl: fake.spawnImpl, now: () => new Date('2026-08-10T01:02:03.004Z') });

  const result = await submitter.submit({ submissionId: entry.submission_id, payload });

  assert.equal(result.ok, true);
  assert.match(result.filename, /^20260810T010203004Z-[0-9a-f-]{36}\.md$/u);
  assert.equal(result.filename, filenameForSubmission(entry.submission_id, new Date('2026-08-10T01:02:03.004Z')));
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, '/retained-fixture/wiki-inbox-submit');
  assert.deepEqual(fake.calls[0].args, [result.filename]);
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fake.calls[0].options.env, undefined);
  assert.equal(Buffer.concat(fake.calls[0].received).toString('utf8'), payload);
  assert.equal(fake.calls[0].endCalls, 1);
  assert.match(payload, /^# Horspowers Inbox Submission\n\n<!-- horspowers-submission:start -->/u);
  assert.equal((payload.match(/horspowers-submission:start/g) ?? []).length, 1);
  assert.match(payload, /## Proposed document/u);
  assert.equal(payload.includes('---\n'), false);
});

test('uses the same strict metadata envelope for every mutation operation and session batch item', () => {
  for (const operation of ['create', 'update', 'archive', 'restore', 'config-change']) {
    const entry = metadata(operation);
    const payload = renderInboxSubmission({ metadata: entry, proposedDocument: '# Proposal\n' });
    assert.match(payload, new RegExp(`"operation": "${operation}"`, 'u'));
    assert.match(payload, new RegExp(`"submission_id": "${entry.submission_id}"`, 'u'));
  }
  const batchItem = renderInboxSubmission({ metadata: metadata('update'), proposedDocument: '# Session update\n' });
  assert.match(batchItem, /# Horspowers Inbox Submission/u);

  const semanticLogicalId = metadata();
  semanticLogicalId.logical_id = 'external-docs-decision';
  assert.doesNotThrow(() => renderInboxSubmission({ metadata: semanticLogicalId, proposedDocument: '# Proposal\n' }));

  for (const logicalId of [
    'company-project-wiki-external-docs',
    'workflow-orchestration-observability-validation',
    'document-runtime-security-validation',
    'workflow-router-v2-document-runtime-integration',
    'company-project-wiki-v2-external-docs',
    'release-2026-08-company-project-wiki-docs',
    'database-migration-backfill-safely',
    'feature-flag-rollout-observations',
    'skills-improvements-from-user-feedback',
    'design-unified-document-system',
    'doc-system-unification-summary',
    'build-cache-clean-retry',
    'alpha-bravo-delta-gamma-theta-omega',
    'api-sdk-cli-http-json-yaml-grpc-oauth',
    'tcp-udp-ipv4-ipv6-dns-tls-ssh-sftp',
    'go-rust-java-node-python-ruby-swift-kotlin',
    'transcription-synchronization-orchestration'
  ]) {
    const readableLogicalId = metadata();
    readableLogicalId.logical_id = logicalId;
    assert.doesNotThrow(() => renderInboxSubmission({ metadata: readableLogicalId, proposedDocument: '# Proposal\n' }), logicalId);
  }

  const readableProjectId = metadata();
  for (const projectId of ['fixture/company-project', 'company/project-wiki-external-docs', NESTED_READABLE_PROJECT_ID]) {
    readableProjectId.project_id = projectId;
    assert.doesNotThrow(() => renderInboxSubmission({ metadata: readableProjectId, proposedDocument: '# Proposal\n' }), projectId);
  }
});

test('rejects malformed submission metadata and payload framing before spawning a receiver', () => {
  const invalidFingerprint = metadata();
  invalidFingerprint.project_fingerprint = 'not-a-fingerprint';
  assert.throws(
    () => renderInboxSubmission({ metadata: invalidFingerprint, proposedDocument: '# Proposal\n' }),
    /invalid inbox submission payload/u
  );

  const inconsistentRevision = metadata('update');
  inconsistentRevision.proposed_revision = 9;
  assert.throws(
    () => renderInboxSubmission({ metadata: inconsistentRevision, proposedDocument: '# Proposal\n' }),
    /invalid inbox submission payload/u
  );

  const extraMetadata = metadata();
  extraMetadata.unexpected = true;
  assert.throws(
    () => renderInboxSubmission({ metadata: extraMetadata, proposedDocument: '# Proposal\n' }),
    /invalid inbox submission payload/u
  );

  for (const [name, mutate] of [
    ['high-entropy project ID', (value) => { value.project_id = 'fixture/aB3dE5fG7hJ9kLmNpQrStUvWxYz01234'; }],
    ['hyphen-split high-entropy project ID', (value) => { value.project_id = 'fixture/abcdefghij-klmnopqrst-uvwxyz012345'; }],
    ['slash-split high-entropy project ID', (value) => { value.project_id = 'fixture/abcdefghij/klmnopqrst/uvwxyz012345'; }],
    ['two-path high-entropy project ID', (value) => { value.project_id = 'aB3dE5fG7hJ9kLm/NpQrStUvWxYz0123'; }],
    ['dot-split high-entropy project ID', (value) => { value.project_id = 'fixture/abcdefghij.klmnopqrst.uvwxyz012345'; }],
    ['low-entropy padded hyphen-split project ID', (value) => {
      value.project_id = `fixture/${LOW_ENTROPY_IDENTIFIER_PADDING}-${OPAQUE_IDENTIFIER_SEGMENTS.join('-')}`;
    }],
    ['low-entropy padded slash-split project ID', (value) => {
      value.project_id = `fixture/${LOW_ENTROPY_IDENTIFIER_PADDING}/${OPAQUE_IDENTIFIER_SEGMENTS.join('/')}`;
    }],
    ['low-entropy padded dot-split project ID', (value) => {
      value.project_id = `fixture/${LOW_ENTROPY_IDENTIFIER_PADDING}.${OPAQUE_IDENTIFIER_SEGMENTS.join('.')}`;
    }],
    ['interleaved low-entropy padded project ID', (value) => { value.project_id = `fixture/${INTERLEAVED_OPAQUE_IDENTIFIER}`; }],
    ['short interleaved low-entropy padded project ID', (value) => { value.project_id = `fixture/${SHORT_INTERLEAVED_OPAQUE_IDENTIFIER}`; }],
    ['repeated non-periodic low-entropy padded project ID', (value) => {
      value.project_id = `fixture/${REPEATED_NON_PERIODIC_INTERLEAVED_OPAQUE_IDENTIFIER}`;
    }],
    ['shorter interleaved low-entropy padded project ID', (value) => { value.project_id = `fixture/${SHORTER_INTERLEAVED_OPAQUE_IDENTIFIER}`; }],
    ['varied ternary low-entropy padded project ID', (value) => {
      value.project_id = `fixture/${VARIED_TERNARY_INTERLEAVED_OPAQUE_IDENTIFIER}`;
    }],
    ['low-entropy short-chunk padded project ID', (value) => {
      value.project_id = `fixture/${LOW_ENTROPY_SHORT_CHUNK_INTERLEAVED_IDENTIFIER}`;
    }],
    ['repeated opaque project ID', (value) => { value.project_id = `fixture/${REPEATED_OPAQUE_IDENTIFIER}`; }],
    ['paired opaque project ID', (value) => { value.project_id = `fixture/${PAIRED_OPAQUE_IDENTIFIER}`; }],
    ['lowercase opaque project ID', (value) => { value.project_id = `fixture/${LOWERCASE_OPAQUE_IDENTIFIER}`; }],
    ['single-character interleaved lowercase opaque project ID', (value) => {
      value.project_id = `fixture/${SINGLE_CHARACTER_INTERLEAVED_LOWERCASE_OPAQUE_IDENTIFIER}`;
    }],
    ['short-segmented opaque project ID', (value) => {
      value.project_id = `fixture/${SHORT_SEGMENTED_OPAQUE_IDENTIFIER}`;
    }],
    ['pronounceable segmented opaque project ID', (value) => {
      value.project_id = `fixture/${PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER}`;
    }],
    ['variable pronounceable segmented opaque project ID', (value) => {
      value.project_id = `fixture/${VARIABLE_PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER}`;
    }],
    ['nearly repeated low-entropy padded project ID', (value) => {
      value.project_id = `fixture/${NEARLY_REPEATED_LOW_ENTROPY_INTERLEAVED_IDENTIFIER}`;
    }],
    ['two-padding one-opaque project ID', (value) => {
      value.project_id = `fixture/${TWO_PADDING_ONE_OPAQUE_INTERLEAVED_IDENTIFIER}`;
    }],
    ['hyphen-split lowercase opaque project ID', (value) => {
      value.project_id = `fixture/${HYPHEN_SPLIT_LOWERCASE_OPAQUE_IDENTIFIER}`;
    }],
    ['three-character padded opaque project ID', (value) => {
      value.project_id = `fixture/${THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['dense three-character padded opaque project ID', (value) => {
      value.project_id = `fixture/${DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['dense four-character padded opaque project ID', (value) => {
      value.project_id = `fixture/${DENSE_FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['distinct dense three-character padded opaque project ID', (value) => {
      value.project_id = `fixture/${DISTINCT_DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['four-character padded opaque project ID', (value) => {
      value.project_id = `fixture/${FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['two-singleton padded opaque project ID', (value) => {
      value.project_id = `fixture/${TWO_SINGLETON_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['distinct low-entropy padded project ID', (value) => {
      value.project_id = `fixture/${DISTINCT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['distinct short low-entropy padded project ID', (value) => {
      value.project_id = `fixture/${DISTINCT_SHORT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['distinct adjacent low-entropy padded project ID', (value) => {
      value.project_id = `fixture/${DISTINCT_ADJACENT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER}`;
    }],
    ['long periodic padded project ID', (value) => { value.project_id = LONG_PERIODIC_PADDING_PROJECT_IDENTIFIER; }],
    ['fullwidth opaque project ID', (value) => { value.project_id = FULLWIDTH_OPAQUE_PROJECT_IDENTIFIER; }],
    ['semantic-looking opaque project ID', (value) => { value.project_id = `fixture/${SEMANTIC_LOOKING_OPAQUE_IDENTIFIER}`; }],
    ['high-entropy logical ID', (value) => { value.logical_id = 'abcdefghijklmnopqrstuvwxyz0123456789'; }],
    ['hyphen-split high-entropy logical ID', (value) => { value.logical_id = 'abcdefghij-klmnopqrst-uvwxyz012345'; }],
    ['interleaved low-entropy padded logical ID', (value) => { value.logical_id = INTERLEAVED_OPAQUE_IDENTIFIER; }],
    ['short interleaved low-entropy padded logical ID', (value) => { value.logical_id = SHORT_INTERLEAVED_OPAQUE_IDENTIFIER; }],
    ['repeated non-periodic low-entropy padded logical ID', (value) => {
      value.logical_id = REPEATED_NON_PERIODIC_INTERLEAVED_OPAQUE_IDENTIFIER;
    }],
    ['shorter interleaved low-entropy padded logical ID', (value) => { value.logical_id = SHORTER_INTERLEAVED_OPAQUE_IDENTIFIER; }],
    ['varied ternary low-entropy padded logical ID', (value) => {
      value.logical_id = VARIED_TERNARY_INTERLEAVED_OPAQUE_IDENTIFIER;
    }],
    ['low-entropy short-chunk padded logical ID', (value) => {
      value.logical_id = LOW_ENTROPY_SHORT_CHUNK_INTERLEAVED_IDENTIFIER;
    }],
    ['repeated opaque logical ID', (value) => { value.logical_id = REPEATED_OPAQUE_IDENTIFIER; }],
    ['paired opaque logical ID', (value) => { value.logical_id = PAIRED_OPAQUE_IDENTIFIER; }],
    ['lowercase opaque logical ID', (value) => { value.logical_id = LOWERCASE_OPAQUE_IDENTIFIER; }],
    ['single-character interleaved lowercase opaque logical ID', (value) => {
      value.logical_id = SINGLE_CHARACTER_INTERLEAVED_LOWERCASE_OPAQUE_IDENTIFIER;
    }],
    ['short-segmented opaque logical ID', (value) => {
      value.logical_id = SHORT_SEGMENTED_OPAQUE_IDENTIFIER;
    }],
    ['pronounceable segmented opaque logical ID', (value) => {
      value.logical_id = PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER;
    }],
    ['variable pronounceable segmented opaque logical ID', (value) => {
      value.logical_id = VARIABLE_PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER;
    }],
    ['nearly repeated low-entropy padded logical ID', (value) => {
      value.logical_id = NEARLY_REPEATED_LOW_ENTROPY_INTERLEAVED_IDENTIFIER;
    }],
    ['two-padding one-opaque logical ID', (value) => {
      value.logical_id = TWO_PADDING_ONE_OPAQUE_INTERLEAVED_IDENTIFIER;
    }],
    ['hyphen-split lowercase opaque logical ID', (value) => {
      value.logical_id = HYPHEN_SPLIT_LOWERCASE_OPAQUE_IDENTIFIER;
    }],
    ['three-character padded opaque logical ID', (value) => {
      value.logical_id = THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER;
    }],
    ['dense three-character padded opaque logical ID', (value) => {
      value.logical_id = DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER;
    }],
    ['distinct dense three-character padded opaque logical ID', (value) => {
      value.logical_id = DISTINCT_DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER;
    }],
    ['four-character padded opaque logical ID', (value) => {
      value.logical_id = FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER;
    }],
    ['two-singleton padded opaque logical ID', (value) => {
      value.logical_id = TWO_SINGLETON_PADDING_OPAQUE_IDENTIFIER;
    }],
    ['distinct low-entropy padded logical ID', (value) => {
      value.logical_id = DISTINCT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER;
    }],
    ['distinct short low-entropy padded logical ID', (value) => {
      value.logical_id = DISTINCT_SHORT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER;
    }],
    ['distinct adjacent low-entropy padded logical ID', (value) => {
      value.logical_id = DISTINCT_ADJACENT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER;
    }],
    ['long periodic padded logical ID', (value) => { value.logical_id = LONG_PERIODIC_PADDING_OPAQUE_IDENTIFIER; }],
    ['eight-character padded logical ID', (value) => { value.logical_id = EIGHT_CHARACTER_PADDING_OPAQUE_IDENTIFIER; }],
    ['decimal character-code logical ID', (value) => { value.logical_id = DECIMAL_CHARACTER_CODE_OPAQUE_IDENTIFIER; }],
    ['semantic-looking opaque logical ID', (value) => { value.logical_id = SEMANTIC_LOOKING_OPAQUE_IDENTIFIER; }]
  ]) {
    const unsafeMetadata = metadata();
    mutate(unsafeMetadata);
    assert.throws(
      () => renderInboxSubmission({ metadata: unsafeMetadata, proposedDocument: '# Proposal\n' }),
      /invalid inbox submission payload/u,
      name
    );
  }

  assert.throws(
    () => renderInboxSubmission({ metadata: metadata(), proposedDocument: '---\r\nforged: true\r\n' }),
    /invalid inbox submission payload/u
  );
});

test('fails closed for oversized payloads, child failures, bounded output, and timeout', async () => {
  const entry = metadata();
  const payload = renderInboxSubmission({ metadata: entry, proposedDocument: '# Proposal\n' });
  const oversizedFake = fakeSpawn();
  const oversized = new InboxSubmitter({
    command: '/retained-fixture/wiki-inbox-submit', timeoutMs: 1000, maxPayloadBytes: 1
  }, { spawnImpl: oversizedFake.spawnImpl });
  assert.equal((await oversized.submit({ submissionId: entry.submission_id, payload })).error_code, 'inbox_payload_too_large');
  assert.equal(oversizedFake.calls.length, 0);

  for (const [mode, expected] of [
    ['nonzero', 'inbox_process_exit'],
    ['stdout-large', 'inbox_response_too_large'],
    ['stderr-large', 'inbox_response_too_large'],
    ['timeout', 'inbox_timeout']
  ]) {
    const fake = fakeSpawn({ mode });
    const submitter = new InboxSubmitter({
      command: '/retained-fixture/wiki-inbox-submit', timeoutMs: 20, maxPayloadBytes: 256 * 1024
    }, { spawnImpl: fake.spawnImpl });
    const result = await submitter.submit({ submissionId: entry.submission_id, payload });
    assert.equal(result.ok, false, mode);
    assert.equal(result.error_code, expected, mode);
  }
});

test('waits for stdin drain before ending a backpressured payload exactly once', async () => {
  const entry = metadata();
  const payload = renderInboxSubmission({ metadata: entry, proposedDocument: '# Proposal\n' });
  const fake = fakeSpawn({ mode: 'backpressure' });
  const submitter = new InboxSubmitter({
    command: '/retained-fixture/wiki-inbox-submit', timeoutMs: 1_000, maxPayloadBytes: 256 * 1024
  }, { spawnImpl: fake.spawnImpl });

  const result = await submitter.submit({ submissionId: entry.submission_id, payload });

  assert.equal(result.ok, true);
  assert.equal(fake.calls[0].endCalls, 1);
  assert.equal(fake.calls[0].endBeforeDrain, false);
  assert.equal(Buffer.concat(fake.calls[0].received).toString('utf8'), payload);
});
