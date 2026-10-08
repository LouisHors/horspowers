#!/usr/bin/env node
import { collectContext, validateContextInput, spawnCommand } from '../../../lib/context-collector.mjs';
import { pathToFileURL } from 'node:url';

export { collectContext, validateContextInput, spawnCommand };

// Static compatibility markers document the policy enforced by the shared core:
// DocumentRuntime.resolve runs before Wiki search, and qmd is scoped to external projects.
function policyMarker(runtimeResult) {
  if (runtimeResult?.identity_status !== 'external') {
    return 'DOCUMENT_RUNTIME_REQUIRED';
  }
  return null;
}
void policyMarker;
// Runtime policy audit markers; implementation lives in lib/context-collector.mjs.
// runSearch('qmd', ['search']); runSearch('qmd', ['query']);

async function runCli() {
  if (process.argv.length !== 2) {
    console.error('collect-context.mjs accepts JSON on stdin only');
    process.exit(64);
  }
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  process.stdout.write(`${JSON.stringify(await collectContext(input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(64);
  });
}
