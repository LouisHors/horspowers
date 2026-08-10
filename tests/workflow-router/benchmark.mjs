#!/usr/bin/env node

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, platform, cpus } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ITERATIONS = 100;
const P95_LIMIT_MS = 150;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const routeScript = path.join(repoRoot, 'skills/using-horspowers/scripts/route-request.mjs');

function percentile(values, fraction) {
  return values[Math.ceil(values.length * fraction) - 1];
}

async function createFixture() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), 'horspowers-router-benchmark-home-'));
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'horspowers-router-benchmark-git-'));
  await writeFile(path.join(fixtureRoot, 'README.md'), 'router benchmark fixture\n', { flag: 'wx' });
  const git = spawnSync('git', ['init'], { cwd: fixtureRoot, encoding: 'utf8' });
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
  await mkdir(path.join(fakeHome, '.codex'));
  return { fakeHome, fixtureRoot };
}

async function main() {
  const { fakeHome, fixtureRoot } = await createFixture();
  const input = JSON.stringify({
    schema_version: 1,
    host: 'codex',
    cwd: fixtureRoot,
    message: '计算 17 乘以 23。',
    active_route: null
  });
  if (Buffer.byteLength(input, 'utf8') > 4 * 1024) throw new Error('benchmark input exceeds 4 KiB');

  const durations = [];
  let routingRuleVersion = null;
  for (let index = 0; index < ITERATIONS; index += 1) {
    const start = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [routeScript], {
      cwd: repoRoot,
      env: { ...process.env, HOME: fakeHome },
      input,
      encoding: 'utf8'
    });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (result.status !== 0) throw new Error(`router run ${index + 1} failed: ${result.stderr}`);
    const output = JSON.parse(result.stdout);
    if (output.routing?.route !== 'direct' || output.routing?.target_skill !== null) {
      throw new Error(`router run ${index + 1} did not take the direct route`);
    }
    routingRuleVersion ??= output.routing.routing_rule_version;
    durations.push(elapsedMs);
  }

  const sorted = [...durations].sort((left, right) => left - right);
  const report = {
    iterations: ITERATIONS,
    milliseconds: {
      p50: Number(percentile(sorted, 0.5).toFixed(3)),
      p95: Number(percentile(sorted, 0.95).toFixed(3)),
      max: Number(sorted.at(-1).toFixed(3))
    },
    environment: {
      os: `${platform()} ${process.arch}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      node: process.version,
      router_version: 1,
      routing_rule_version: routingRuleVersion
    },
    fixture: {
      fake_home: fakeHome,
      git_root: fixtureRoot,
      preserved: true
    }
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.milliseconds.p95 > P95_LIMIT_MS) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
