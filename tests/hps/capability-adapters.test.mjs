import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adaptHostCapabilities,
  createClaudeCapabilityAdapter,
  createCodexCapabilityAdapter,
  createOpenCodeCapabilityAdapter
} from '../../lib/hps-capabilities.mjs';
import { HpsRuntime } from '../../lib/hps-runtime.mjs';

const all = {
  workspace_read: true,
  workspace_write: true,
  external_network: true,
  local_process: true,
  wiki_read: true,
  wiki_submit: true,
  approval_available: true
};

function facts(host, capabilities = all) {
  return { host, verified: true, source: 'fixture', capabilities };
}

test('three host adapters accept verified matching fixtures and preserve explicit false', () => {
  for (const [host, factory] of Object.entries({
    codex: createCodexCapabilityAdapter,
    claude: createClaudeCapabilityAdapter,
    opencode: createOpenCodeCapabilityAdapter
  })) {
    const adapter = factory({ facts: facts(host, { ...all, workspace_write: false }) });
    assert.equal(adapter.host, host);
    assert.equal(adapter.verified, true);
    assert.equal(adapter.capabilities.workspace_read, true);
    assert.equal(adapter.capabilities.workspace_write, false);
    assert.equal(adapter.capabilities.local_process, true);
  }
});

test('missing, unverified, mismatched, and nonboolean facts fail closed', () => {
  for (const host of ['codex', 'claude', 'opencode']) {
    for (const input of [
      {},
      { host, verified: false, capabilities: all },
      { host: 'other', verified: true, capabilities: all },
      { host, verified: true, capabilities: { ...all, local_process: 'true' } }
    ]) {
      const result = adaptHostCapabilities({ host, facts: input });
      if (input.verified === true && input.host === host && typeof input.capabilities?.local_process !== 'boolean') {
        assert.equal(result.capabilities.local_process, false, `${host}: nonboolean field`);
      } else {
        assert.ok(Object.values(result.capabilities).every((value) => value === false), `${host}: ${JSON.stringify(input)}`);
        assert.equal(result.verified, false);
      }
    }
  }
});

test('persistent_session is derived only from verified sidecar process facts', () => {
  const hostFacts = facts('codex', { ...all, persistent_session: true });
  assert.equal(adaptHostCapabilities({ host: 'codex', facts: hostFacts }).capabilities.persistent_session, false);
  assert.equal(adaptHostCapabilities({
    host: 'codex',
    facts: hostFacts,
    sidecarProcessFacts: { source: 'hps-sidecar', verified: true, persistent_session: true }
  }).capabilities.persistent_session, true);
  assert.equal(adaptHostCapabilities({
    host: 'codex', facts: facts('codex'),
    sidecarProcessFacts: { source: 'hps-sidecar', verified: false, persistent_session: true }
  }).capabilities.persistent_session, false);
});

test('runtime uses startup adapter facts and operation input cannot elevate capabilities', async () => {
  const runtime = new HpsRuntime({
    host: 'codex',
    hostFacts: facts('codex', { ...all, local_process: false }),
    sidecarProcessFacts: { source: 'hps-sidecar', verified: true, persistent_session: true }
  });
  const doctor = await runtime.runtimeDoctor();
  assert.equal(doctor.capabilities.local_process, false);
  assert.equal(doctor.capabilities.persistent_session, true);
  assert.equal(doctor.capability_verification.host, 'codex');
  assert.equal(doctor.capability_verification.verified, true);
  const scope_id = runtime.openScope({ root: process.cwd() });
  const result = await runtime.verificationRun({
    cwd: process.cwd(), scope_id, profile: 'hps-unit',
    input: { capabilities: { local_process: true }, host: 'claude' }
  });
  assert.equal(result.error_code, 'local_process_required');
});

test('runtime rejects an untrusted adapter-shaped object even when it claims verified host facts', async () => {
  const runtime = new HpsRuntime({
    capabilityAdapter: {
      host: 'codex',
      verified: true,
      capabilities: { local_process: true }
    }
  });
  const doctor = await runtime.runtimeDoctor();
  assert.equal(doctor.capabilities.local_process, false);
  assert.equal(doctor.capability_verification.verified, false);
  assert.equal(doctor.capability_verification.host, null);
});
