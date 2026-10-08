/**
 * Capability adapters for the supported agent hosts.
 *
 * The adapter accepts only a startup fact envelope. Per-operation payloads are
 * deliberately not part of this API, so an operation cannot promote a
 * capability after the runtime has started. A value is usable only when the
 * envelope explicitly identifies the expected host and marks itself verified;
 * every other value is fail-closed.
 */

export const HPS_CAPABILITY_KEYS = Object.freeze([
  'workspace_read',
  'workspace_write',
  'external_network',
  'local_process',
  'wiki_read',
  'wiki_submit',
  'persistent_session',
  'approval_available'
]);

export const HPS_HOSTS = Object.freeze(['codex', 'claude', 'opencode']);

// Runtime must not trust an arbitrary object that merely resembles an adapter
// result. Keep provenance private to this module so only results produced by
// the canonical adapter constructors can satisfy the startup-facts contract.
const trustedAdapterResults = new WeakSet();

function emptyCapabilities() {
  return Object.fromEntries(HPS_CAPABILITY_KEYS.map((key) => [key, false]));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verifiedHostFacts(host, facts) {
  return isRecord(facts) && facts.verified === true && facts.host === host;
}

function readCapabilityFacts(facts) {
  // Keep the canonical location under `capabilities`; accepting top-level
  // fields makes adapters usable with simple host launch probes while still
  // requiring each field itself to be boolean.
  const nested = isRecord(facts?.capabilities) ? facts.capabilities : {};
  return Object.fromEntries(HPS_CAPABILITY_KEYS
    .filter((key) => key !== 'persistent_session')
    .map((key) => {
      const value = Object.hasOwn(nested, key) ? nested[key] : facts?.[key];
      return [key, value === true];
    }));
}

function sidecarPersistentSession(sidecarProcessFacts) {
  // Host facts cannot assert persistence. Only an explicitly verified fact
  // emitted by the in-process HPS sidecar can do so.
  return isRecord(sidecarProcessFacts) &&
    sidecarProcessFacts.source === 'hps-sidecar' &&
    sidecarProcessFacts.verified === true &&
    sidecarProcessFacts.persistent_session === true;
}

export function adaptHostCapabilities({ host, facts = null, sidecarProcessFacts = null } = {}) {
  const capabilities = emptyCapabilities();
  const supported = HPS_HOSTS.includes(host);
  const verified = supported && verifiedHostFacts(host, facts);
  if (verified) Object.assign(capabilities, readCapabilityFacts(facts));
  capabilities.persistent_session = verified && sidecarPersistentSession(sidecarProcessFacts);
  const result = Object.freeze({
    host: supported ? host : null,
    verified,
    source: verified && typeof facts.source === 'string' ? facts.source : null,
    reason: verified ? null : supported ? 'host_facts_unverified' : 'host_not_supported',
    persistent_session_source: sidecarPersistentSession(sidecarProcessFacts) ? 'hps-sidecar' : null,
    capabilities: Object.freeze(capabilities)
  });
  trustedAdapterResults.add(result);
  return result;
}

export function isTrustedCapabilityAdapter(value) {
  return isRecord(value) && trustedAdapterResults.has(value);
}

export function createCodexCapabilityAdapter(options = {}) {
  return adaptHostCapabilities({ ...options, host: 'codex' });
}

export function createClaudeCapabilityAdapter(options = {}) {
  return adaptHostCapabilities({ ...options, host: 'claude' });
}

export function createOpenCodeCapabilityAdapter(options = {}) {
  return adaptHostCapabilities({ ...options, host: 'opencode' });
}

export const HOST_CAPABILITY_ADAPTERS = Object.freeze({
  codex: createCodexCapabilityAdapter,
  claude: createClaudeCapabilityAdapter,
  opencode: createOpenCodeCapabilityAdapter
});
