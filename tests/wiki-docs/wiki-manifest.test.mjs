import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  validateConfigManifestEntry,
  validateWikiManifest
} from '../../lib/wiki-manifest.mjs';

const COLLECTION = 'my-code-wiki';
const ROOT_URI = 'qmd://my-code-wiki/projects/ugcli-lib';
const CONFIG_URI = `${ROOT_URI}/horspowers-config.md`;
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const CONFIG_PAGE = '# config page\r\n<!-- horspowers-config:start -->\n```json\n{}\n```\n<!-- horspowers-config:end -->\n';
const CONFIG_HASH = createHash('sha256').update(CONFIG_PAGE, 'utf8').digest('hex');

function expected(projectId = 'ugnas/ugcli-lib') {
  return {
    project_id: projectId,
    project_fingerprint: FINGERPRINT,
    collection: COLLECTION,
    root_uri: ROOT_URI
  };
}

function manifest(overrides = {}) {
  const value = {
    schema_version: 1,
    project_id: 'ugnas/ugcli-lib',
    project_fingerprint: FINGERPRINT,
    documents: {
      'horspowers-config': {
        document_type: 'config',
        uri: CONFIG_URI,
        revision: 3,
        status: 'active',
        content_sha256: CONFIG_HASH,
        updated_at: '2026-08-10T00:00:00Z'
      },
      'implement-feature': {
        document_type: 'task',
        uri: `${ROOT_URI}/tasks/implement-feature.md`,
        revision: 2,
        status: 'active',
        content_sha256: 'b'.repeat(64),
        updated_at: '2026-08-10T00:00:00Z'
      }
    }
  };
  return { ...value, ...overrides };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('accepts a strict manifest rooted in the configured project URI', () => {
  const result = validateWikiManifest(manifest(), expected());

  assert.equal(result.ok, true);
  assert.equal(result.manifest.documents['implement-feature'].revision, 2);

  const opaqueProjectId = 'ugnas/UGCLI Library';
  assert.equal(validateWikiManifest(
    manifest({ project_id: opaqueProjectId }),
    expected(opaqueProjectId)
  ).ok, true);
});

test('rejects unknown fields, logical ID errors, invalid revisions, and escaped roots', () => {
  const cases = [
    ['unknown root field', (value) => { value.unexpected = true; }],
    ['unknown document field', (value) => { value.documents['implement-feature'].unexpected = true; }],
    ['invalid logical ID', (value) => {
      value.documents['Uppercase'] = value.documents['implement-feature'];
      delete value.documents['implement-feature'];
    }],
    ['nonpositive revision', (value) => { value.documents['implement-feature'].revision = 0; }],
    ['non UTC timestamp', (value) => { value.documents['implement-feature'].updated_at = '2026-08-10T08:00:00+08:00'; }],
    ['nonexistent UTC calendar date', (value) => { value.documents['implement-feature'].updated_at = '2026-02-30T00:00:00Z'; }],
    ['nonexistent UTC calendar date', (value) => { value.documents['implement-feature'].updated_at = '2026-02-30T00:00:00Z'; }],
    ['outside root segment', (value) => { value.documents['implement-feature'].uri = 'qmd://my-code-wiki/projects/ugcli-library/tasks/implement-feature.md'; }],
    ['encoded traversal', (value) => { value.documents['implement-feature'].uri = 'qmd://my-code-wiki/projects/ugcli-lib/%2e%2e/other.md'; }],
    ['invalid hash', (value) => { value.documents['implement-feature'].content_sha256 = 'UPPERCASE'; }]
  ];

  for (const [name, mutate] of cases) {
    const value = clone(manifest());
    mutate(value);
    assert.equal(validateWikiManifest(value, expected()).ok, false, name);
  }
});

test('rejects project identity mismatches instead of accepting a similarly rooted manifest', () => {
  const projectIdMismatch = manifest({ project_id: 'ugnas/other' });
  assert.equal(validateWikiManifest(projectIdMismatch, expected()).ok, false);

  const fingerprintMismatch = manifest({ project_fingerprint: `sha256:${'c'.repeat(64)}` });
  assert.equal(validateWikiManifest(fingerprintMismatch, expected()).ok, false);
});

test('requires the fixed horspowers-config manifest entry to bind URI, hash, type, status, and revision', () => {
  const accepted = validateConfigManifestEntry(manifest(), {
    config_uri: CONFIG_URI,
    config_page: CONFIG_PAGE
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.revision, 3);

  const cases = [
    ['missing entry', (value) => { delete value.documents['horspowers-config']; }],
    ['wrong URI', (value) => { value.documents['horspowers-config'].uri = `${ROOT_URI}/other.md`; }],
    ['zero revision', (value) => { value.documents['horspowers-config'].revision = 0; }],
    ['wrong document type', (value) => { value.documents['horspowers-config'].document_type = 'task'; }],
    ['wrong status', (value) => { value.documents['horspowers-config'].status = 'archived'; }],
    ['wrong raw-page hash', (value) => { value.documents['horspowers-config'].content_sha256 = '0'.repeat(64); }]
  ];

  for (const [name, mutate] of cases) {
    const value = clone(manifest());
    mutate(value);
    const result = validateConfigManifestEntry(value, {
      config_uri: CONFIG_URI,
      config_page: CONFIG_PAGE
    });
    assert.equal(result.ok, false, name);
    assert.equal(result.error_code, 'config_manifest_mismatch', name);
  }
});
