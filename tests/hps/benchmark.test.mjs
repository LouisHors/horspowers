import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HpsRuntime } from '../../lib/hps-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hpsBin = path.join(repoRoot, 'bin/hps');

function percentile(samples, fraction) {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

async function sample(count, operation) {
  const durations = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await operation(index);
    durations.push(performance.now() - started);
  }
  return { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), samples: durations };
}

function coldCliCall(requestId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hpsBin, 'call'], {
      cwd: repoRoot, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`cold hps call failed (${code}): ${stderr}`));
      else resolve(JSON.parse(stdout.trim()));
    });
    child.stdin.end(`${JSON.stringify({
      schema_version: 1, request_id: requestId, operation: 'runtime_doctor', cwd: repoRoot, input: {}
    })}\n`);
  });
}

test('real cold CLI and warm Sidecar snapshot publish P50/P95 without empty I/O stubs', async (t) => {
  const cold = await sample(5, async (index) => {
    const response = await coldCliCall(`cold-${index}`);
    assert.equal(response.status, 'ok');
  });

  const runtime = new HpsRuntime();
  await runtime.projectSnapshot({ cwd: repoRoot });
  const warm = await sample(21, async () => {
    const snapshot = await runtime.projectSnapshot({ cwd: repoRoot });
    assert.equal(snapshot.root, repoRoot);
  });

  t.diagnostic(`cold_cli_p50_ms=${cold.p50.toFixed(2)} cold_cli_p95_ms=${cold.p95.toFixed(2)}`);
  t.diagnostic(`warm_snapshot_p50_ms=${warm.p50.toFixed(2)} warm_snapshot_p95_ms=${warm.p95.toFixed(2)}`);
  assert.ok(Number.isFinite(cold.p50) && Number.isFinite(cold.p95));
  assert.ok(warm.p50 < 100, `warm snapshot P50 ${warm.p50.toFixed(2)}ms`);
});

test('real direct and collector-backed slow prepare meet the Phase 1/2 budgets', async (t) => {
  const directRuntime = new HpsRuntime();
  const direct = await sample(15, async () => {
    const prepared = await directRuntime.taskPrepare({ cwd: repoRoot, input: { message: 'what is JSON' } });
    assert.equal(prepared.routing.route, 'direct');
  });

  const slowRuntime = new HpsRuntime({
    planProject: async () => ({
      eligibility: 'external_project', project_root: repoRoot,
      identity: { kind: 'company', project_fingerprint: `sha256:${'a'.repeat(64)}` }
    }),
    resolveProjectContext: async () => ({
      status: 'ready', identity_status: 'company',
      project: { root: repoRoot, identity_status: 'company', project_fingerprint: `sha256:${'a'.repeat(64)}` },
      config_status: 'valid', documentation: { backend: 'wiki', enabled: true }
    })
  });
  const slow = await sample(7, async () => {
    const prepared = await slowRuntime.taskPrepare({
      cwd: repoRoot,
      input: { message: '使用 brainstorming 设计 Agent CLI', query: 'HpsRuntime', known_entry_files: [path.join(repoRoot, 'README.md')] }
    });
    assert.equal(prepared.metrics.context_collected, true);
    assert.equal(prepared.collected.branches.repository.status, 'ok');
    assert.equal(prepared.collected.branches.git.status, 'ok');
  });

  t.diagnostic(`direct_prepare_p50_ms=${direct.p50.toFixed(2)} direct_prepare_p95_ms=${direct.p95.toFixed(2)}`);
  t.diagnostic(`slow_prepare_p50_ms=${slow.p50.toFixed(2)} slow_prepare_p95_ms=${slow.p95.toFixed(2)}`);
  assert.ok(direct.p50 <= 200, `direct prepare P50 ${direct.p50.toFixed(2)}ms`);
  assert.ok(slow.p50 <= 1_200, `slow prepare P50 ${slow.p50.toFixed(2)}ms`);
});
