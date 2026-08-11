import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectSubmissionMetadataIdentifier,
  validateAndSerializeSafeDocument
} from '../../lib/submission-safety.mjs';

const LOW_ENTROPY_IDENTIFIER_PADDING = 'a'.repeat(40);
const OPAQUE_IDENTIFIER_SEGMENTS = ['abcdefghij', 'klmnopqrst', 'uvwxyz012345'];
const INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('a'.repeat(12));
const PERIODICALLY_INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('abc'.repeat(4));
const SHORT_INTERLEAVED_OPAQUE_IDENTIFIER = ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('a'.repeat(7));
const REPEATED_NON_PERIODIC_INTERLEAVED_OPAQUE_IDENTIFIER =
  ['a3d5e7f', 'g9h2j4k', 'm6n8p0q', 'r2s4t6u'].join('000000010');
const VARIED_LOW_ENTROPY_INTERLEAVED_OPAQUE_IDENTIFIER =
  `a3d5e7f${'a'.repeat(7)}g9h2j4k${'b'.repeat(7)}m6n8p0q${'c'.repeat(7)}r2s4t6u`;
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
    references: [{ document_type: 'decision', logical_id: 'related-decision' }]
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
    ['space-indented code block', (value) => { value.sections[0].paragraphs = ['    console.log("copied source")']; }],
    ['tab-indented code block', (value) => { value.sections[0].paragraphs = ['\tconsole.log("copied source")']; }],
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

test('rejects high-entropy logical IDs in structured references', async () => {
  for (const logicalId of [
    'abcdefghijklmnopqrstuvwxyz0123456789',
    'abcdefghij-klmnopqrst-uvwxyz012345',
    `${LOW_ENTROPY_IDENTIFIER_PADDING}-${OPAQUE_IDENTIFIER_SEGMENTS.join('-')}`,
    INTERLEAVED_OPAQUE_IDENTIFIER,
    PERIODICALLY_INTERLEAVED_OPAQUE_IDENTIFIER,
    SHORT_INTERLEAVED_OPAQUE_IDENTIFIER,
    REPEATED_NON_PERIODIC_INTERLEAVED_OPAQUE_IDENTIFIER,
    VARIED_LOW_ENTROPY_INTERLEAVED_OPAQUE_IDENTIFIER,
    SHORTER_INTERLEAVED_OPAQUE_IDENTIFIER,
    VARIED_TERNARY_INTERLEAVED_OPAQUE_IDENTIFIER,
    LOW_ENTROPY_SHORT_CHUNK_INTERLEAVED_IDENTIFIER,
    REPEATED_OPAQUE_IDENTIFIER,
    PAIRED_OPAQUE_IDENTIFIER,
    LOWERCASE_OPAQUE_IDENTIFIER,
    SINGLE_CHARACTER_INTERLEAVED_LOWERCASE_OPAQUE_IDENTIFIER,
    SHORT_SEGMENTED_OPAQUE_IDENTIFIER,
    PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER,
    VARIABLE_PRONOUNCEABLE_SEGMENTED_OPAQUE_IDENTIFIER,
    NEARLY_REPEATED_LOW_ENTROPY_INTERLEAVED_IDENTIFIER,
    TWO_PADDING_ONE_OPAQUE_INTERLEAVED_IDENTIFIER,
    HYPHEN_SPLIT_LOWERCASE_OPAQUE_IDENTIFIER,
    THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    DISTINCT_DENSE_THREE_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    TWO_SINGLETON_PADDING_OPAQUE_IDENTIFIER,
    DISTINCT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER,
    DISTINCT_SHORT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER,
    DISTINCT_ADJACENT_LOW_ENTROPY_PADDING_OPAQUE_IDENTIFIER,
    LONG_PERIODIC_PADDING_OPAQUE_IDENTIFIER,
    EIGHT_CHARACTER_PADDING_OPAQUE_IDENTIFIER,
    DECIMAL_CHARACTER_CODE_OPAQUE_IDENTIFIER,
    SEMANTIC_LOOKING_OPAQUE_IDENTIFIER
  ]) {
    const value = validDocument();
    value.references[0].logical_id = logicalId;

    const result = await validate(value);

    assert.equal(result.ok, false, logicalId);
    assert.equal(result.error_code, 'submission_safety_blocked', logicalId);
    assert.deepEqual(result.errors, [{ path: '$.references[0].logical_id', code: 'high_entropy_credential' }], logicalId);
    assert.equal(JSON.stringify(result).includes(logicalId), false, logicalId);
  }
});

test('rejects dense four-character low-entropy padding in metadata identifiers', () => {
  const result = inspectSubmissionMetadataIdentifier(DENSE_FOUR_CHARACTER_PADDING_OPAQUE_IDENTIFIER, {
    projectId: true
  });

  assert.deepEqual(result, { ok: false, category: 'high_entropy_credential' });
});

test('rejects long periodic padding and semantic-looking opaque metadata identifiers', () => {
  for (const [value, options] of [
    [LONG_PERIODIC_PADDING_OPAQUE_IDENTIFIER, {}],
    [EIGHT_CHARACTER_PADDING_OPAQUE_IDENTIFIER, {}],
    [LONG_PERIODIC_PADDING_PROJECT_IDENTIFIER, { projectId: true }],
    [DECIMAL_CHARACTER_CODE_OPAQUE_IDENTIFIER, {}],
    [FULLWIDTH_OPAQUE_PROJECT_IDENTIFIER, { projectId: true }],
    [SEMANTIC_LOOKING_OPAQUE_IDENTIFIER, {}]
  ]) {
    assert.deepEqual(
      inspectSubmissionMetadataIdentifier(value, options),
      { ok: false, category: 'high_entropy_credential' },
      value
    );
  }
});

test('rejects bounded periodic low-complexity padding for logical and project metadata', () => {
  const core = OPAQUE_IDENTIFIER_CORE;
  const padding = (length, variant, index) => {
    const alphabet = variant === 0 ? 'a' : variant === 1 ? 'abcd' : 'abc';
    return Array.from({ length }, (_, offset) => alphabet[(offset + (variant === 2 ? index : 0)) % alphabet.length]).join('');
  };

  for (let carrierWidth = 1; carrierWidth <= 16; carrierWidth += 1) {
    const chunks = core.match(new RegExp(`.{1,${carrierWidth}}`, 'gu'));
    for (let paddingWidth = 3; paddingWidth <= 16; paddingWidth += 1) {
      for (let variant = 0; variant < 3; variant += 1) {
        const value = chunks.map((chunk, index) =>
          index === chunks.length - 1 ? chunk : `${chunk}${padding(paddingWidth, variant, index)}`
        ).join('');
        if (value.length <= 81) {
          assert.equal(inspectSubmissionMetadataIdentifier(value).ok, false, `logical:${carrierWidth}:${paddingWidth}:${variant}`);
        }
        assert.equal(
          inspectSubmissionMetadataIdentifier(`group/${value}`, { projectId: true }).ok,
          false,
          `project:${carrierWidth}:${paddingWidth}:${variant}`
        );
      }
    }
  }
});

test('allows readable semantic identifiers without granting arbitrary hyphen or padding exemptions', async () => {
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
    const value = validDocument();
    value.references[0].logical_id = logicalId;

    const result = await validate(value);

    assert.equal(result.ok, true, logicalId);
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
