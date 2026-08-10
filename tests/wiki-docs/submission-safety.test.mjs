import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAndSerializeSafeDocument } from '../../lib/submission-safety.mjs';

function validDocument() {
  return {
    schema_version: 1,
    format: 'safe-document',
    title: 'Company project document boundary',
    sections: [{
      heading: 'Summary',
      paragraphs: ['Describe the behavior without reproducing implementation source.'],
      bullets: ['Use a bounded transport.', 'Verify the documented behavior.'],
      files: [{ operation: 'modify', path: 'lib/project-identity.mjs' }],
      implementation_specs: [{
        kind: 'function',
        language: 'javascript',
        symbol: 'normalizeRemoteUrl',
        inputs: ['remoteUrl: string'],
        outputs: ['normalized identity'],
        rules: ['parse supported URL forms'],
        errors: ['return invalid for malformed input']
      }],
      commands: [{
        program: 'node',
        args: ['--test', 'tests/wiki-docs/project-identity.test.mjs'],
        expected: 'PASS'
      }]
    }],
    references: [{ document_type: 'decision', logical_id: 'external-docs-decision' }]
  };
}

async function allowSimilarity() {
  return { ok: true };
}

async function validate(content, options = {}) {
  return validateAndSerializeSafeDocument(content, '/retained-fixture/project', {
    sourceSimilarityGuard: allowSimilarity,
    ...options
  });
}

test('serializes a strict safe-document with structured files, commands, and implementation contracts', async () => {
  const result = await validate(validDocument());

  assert.equal(result.ok, true);
  assert.match(result.markdown, /^# Company project document boundary\n/u);
  assert.match(result.markdown, /lib\/project-identity\.mjs/u);
  assert.match(result.markdown, /Expected: PASS/u);
  assert.match(result.markdown, /normalizeRemoteUrl/u);
  assert.equal(result.markdown.includes('```'), false);
});

test('rejects unknown structure, raw code/content fields, and unsafe document syntax without echoing content', async () => {
  const cases = [
    ['unknown root field', (value) => { value.unexpected = true; }],
    ['arbitrary code field', (value) => { value.sections[0].code = 'const leaked = true'; }],
    ['arbitrary body field', (value) => { value.sections[0].body = 'unmodelled body'; }],
    ['raw markdown fence', (value) => { value.sections[0].paragraphs = ['```javascript']; }],
    ['HTML', (value) => { value.sections[0].paragraphs = ['<script>unsafe</script>']; }],
    ['blockquote', (value) => { value.sections[0].paragraphs = ['> quoted source']; }],
    ['external URL', (value) => { value.sections[0].paragraphs = ['https://example.invalid/source']; }],
    ['absolute file', (value) => { value.sections[0].files[0].path = '/private/source.js'; }],
    ['traversal file', (value) => { value.sections[0].files[0].path = '../source.js'; }],
    ['shell metacharacter', (value) => { value.sections[0].commands[0].args = ['--test;rm']; }],
    ['absolute command argument', (value) => { value.sections[0].commands[0].args = ['/private/test.mjs']; }],
    ['unsupported program', (value) => { value.sections[0].commands[0].program = 'curl'; }],
    ['unsupported language', (value) => { value.sections[0].implementation_specs[0].language = 'c'; }],
    ['unsupported specification kind', (value) => { value.sections[0].implementation_specs[0].kind = 'code'; }],
    ['diff hunk', (value) => { value.sections[0].paragraphs = ['@@ -1,1 +1,1 @@']; }],
    ['stack shape', (value) => { value.sections[0].paragraphs = ['at loadConfig (lib/config.mjs:42)']; }],
    ['log shape', (value) => { value.sections[0].paragraphs = ['2026-08-10T00:00:00Z first log', '2026-08-10T00:00:01Z second log']; }],
    ['private key', (value) => { value.sections[0].paragraphs = ['-----BEGIN PRIVATE KEY-----']; }],
    ['authorization', (value) => { value.sections[0].paragraphs = ['Authorization: Bearer secret-value']; }],
    ['API key assignment', (value) => { value.sections[0].paragraphs = ['X-Api-Key: short-value']; }],
    ['high entropy marker', (value) => { value.sections[0].paragraphs = ['aB3dE5fG7hJ9kLmNpQrStUvWxYz01234']; }],
    ['high entropy implementation symbol', (value) => {
      value.sections[0].implementation_specs[0].symbol = 'aB3dE5fG7hJ9kLmNpQrStUvWxYz01234';
    }]
  ];

  for (const [name, mutate] of cases) {
    const value = validDocument();
    mutate(value);
    const result = await validate(value);
    assert.equal(result.ok, false, name);
    assert.ok(['safe_document_required', 'submission_safety_blocked'].includes(result.error_code), name);
    assert.equal(JSON.stringify(result).includes('secret-value'), false, name);
  }
});

test('rejects raw Markdown, non-HTTP URLs, and environment assignments in every free-text boundary', async () => {
  const cases = [
    ['title fence', (value) => { value.title = 'Unsafe ``` title'; }],
    ['heading fence', (value) => { value.sections[0].heading = 'Unsafe ``` heading'; }],
    ['paragraph heading', (value) => { value.sections[0].paragraphs = ['# Copied heading']; }],
    ['inline code', (value) => { value.sections[0].paragraphs = ['Use `copied implementation` directly.']; }],
    ['relative Markdown link', (value) => { value.sections[0].paragraphs = ['[copied source](src/source.js)']; }],
    ['reference-style Markdown link', (value) => { value.sections[0].paragraphs = ['[copied source]: src/source.js']; }],
    ['setext Markdown heading', (value) => { value.sections[0].paragraphs = ['Copied heading\n===']; }],
    ['SSH URL', (value) => { value.sections[0].paragraphs = ['ssh://git@example.invalid/project']; }],
    ['QMD URL', (value) => { value.sections[0].paragraphs = ['qmd://my-code-wiki/projects/other']; }],
    ['environment assignment', (value) => { value.sections[0].paragraphs = ['CONFIG=dev']; }]
  ];

  for (const [name, mutate] of cases) {
    const value = validDocument();
    mutate(value);
    const result = await validate(value);
    assert.equal(result.ok, false, name);
    assert.equal(result.error_code, 'submission_safety_blocked', name);
  }
});

test('rejects unfenced executable source syntax rather than treating it as prose', async () => {
  const cases = [
    ['JavaScript function', 'function increment(value) { return value + 1; }'],
    ['TypeScript arrow function', 'const increment = (value: number): number => value + 1;'],
    ['Python function', 'def increment(value):\n    return value + 1'],
    ['Go function', 'func Increment(value int) int { return value + 1 }']
  ];

  for (const [name, source] of cases) {
    const value = validDocument();
    value.sections[0].paragraphs = [source];
    const result = await validate(value);
    assert.equal(result.ok, false, name);
    assert.equal(result.error_code, 'submission_safety_blocked', name);
    assert.equal(JSON.stringify(result).includes(source), false, name);
  }
});

test('rejects sparse AST arrays and fails closed when the source scanner cannot run', async () => {
  const sparse = validDocument();
  sparse.sections = new Array(1);
  const sparseResult = await validate(sparse);
  assert.equal(sparseResult.ok, false);
  assert.equal(sparseResult.error_code, 'safe_document_required');

  const scannerFailure = await validate(validDocument(), {
    sourceSimilarityGuard: async () => {
      throw new Error('source scanner internal detail must not escape');
    }
  });
  assert.equal(scannerFailure.ok, false);
  assert.equal(scannerFailure.error_code, 'source_scan_incomplete');
  assert.equal(JSON.stringify(scannerFailure).includes('internal detail'), false);
});

test('enforces fixed limits and propagates source-similarity failures without raw matches', async () => {
  const oversized = validDocument();
  oversized.sections[0].paragraphs = Array.from({ length: 13 }, () => 'bounded paragraph');
  const limitResult = await validate(oversized);
  assert.equal(limitResult.ok, false);
  assert.equal(limitResult.error_code, 'safe_document_required');

  const sourceResult = await validate(validDocument(), {
    sourceSimilarityGuard: async () => ({
      ok: false,
      error_code: 'raw_source_detected',
      matches: [{ value: 'do not expose source' }]
    })
  });
  assert.equal(sourceResult.ok, false);
  assert.equal(sourceResult.error_code, 'raw_source_detected');
  assert.equal(JSON.stringify(sourceResult).includes('do not expose source'), false);

  const matchedPath = await validate(validDocument(), {
    sourceSimilarityGuard: async () => ({
      ok: false,
      error_code: 'raw_source_detected',
      paths: ['$.sections[0].bullets[0]']
    })
  });
  assert.equal(matchedPath.ok, false);
  assert.equal(matchedPath.errors[0].path, '$.sections[0].bullets[0]');
});
