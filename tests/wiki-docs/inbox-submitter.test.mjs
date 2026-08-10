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
