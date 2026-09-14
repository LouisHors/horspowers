import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.');

async function source(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

test('legacy entrypoints remain thin wrappers around shared Core modules', async () => {
  const [route, documentCli, collector, startHook, endHook] = await Promise.all([
    source('skills/using-horspowers/scripts/route-request.mjs'),
    source('lib/document-runtime-cli.mjs'),
    source('skills/brainstorming/scripts/collect-context.mjs'),
    source('hooks/session-start.sh'),
    source('hooks/session-end.sh')
  ]);

  assert.match(route, /from ['"]\.\.\/\.\.\/\.\.\/lib\/workflow-router\.mjs['"]/u);
  assert.match(route, /from ['"]\.\.\/\.\.\/\.\.\/lib\/hps-legacy-route-bridge\.mjs['"]/u);
  assert.match(route, /routeRequestWithHps\(input\)/u);
  assert.ok(route.split('\n').length < 40);

  assert.match(documentCli, /from ['"]\.\/document-runtime\.mjs['"]/u);
  assert.match(documentCli, /runtime\.execute\(parsed\.value\)/u);
  assert.doesNotMatch(documentCli, /resolveProjectContext|QmdMcpClient|LocalDocsBackend/u);

  assert.match(collector, /from ['"]\.\.\/\.\.\/\.\.\/lib\/context-collector\.mjs['"]/u);
  assert.ok(collector.split('\n').length < 50);

  for (const hook of [startHook, endHook]) {
    assert.match(hook, /session-hook-runtime\.mjs/u);
    assert.ok(hook.split('\n').length < 12);
  }
});
