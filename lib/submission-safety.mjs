import { scanSourceSimilarity } from './source-similarity-guard.mjs';

const MAX_AST_BYTES = 192 * 1024;
const MAX_MARKDOWN_BYTES = 224 * 1024;
const DOCUMENT_TYPES = new Set(['design', 'plan', 'task', 'bug', 'decision', 'context', 'config', 'session']);
const FILE_OPERATIONS = new Set(['create', 'modify', 'test', 'review']);
const SPEC_LANGUAGES = new Set(['javascript', 'typescript', 'python', 'go', 'rust', 'shell', 'json', 'yaml', 'text']);
const SPEC_KINDS = new Set(['function', 'class', 'module', 'script', 'schema', 'command']);
const COMMAND_PROGRAMS = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bash', 'sh', 'git', 'go', 'cargo', 'pytest', 'python3', 'ruby', 'rg', 'make', 'cmake']);
const LOGICAL_ID = /^[a-z0-9][a-z0-9-]{0,80}$/u;
const SYMBOL = /^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$/u;
const FILE_PATH = /^[A-Za-z0-9._/-]+$/u;
const HIGH_ENTROPY_MIN_LENGTH = 20;
const HIGH_ENTROPY_THRESHOLD = 3.5;
const MAX_METADATA_IDENTIFIER_SCAN_BYTES = 512;
const LOW_COMPLEXITY_PADDING_MIN_LENGTH = 3;
const LOW_COMPLEXITY_PADDING_MAX_ENTROPY = 2.2;
const PAIRED_IDENTIFIER_MIN_PAIRS = 10;
const SINGLETON_INTERLEAVE_PADDING_MAX_ENTROPY = 1;
const PERIODIC_INTERLEAVE_MAX_CARRIER_LENGTH = 16;
const PERIODIC_INTERLEAVE_MAX_PADDING_LENGTH = 64;
const HUMAN_READABLE_METADATA_TOKENS = new Set(
  'api sdk cli http https json yaml yml xml grpc oauth oidc tcp udp ipv ipv4 ipv6 dns tls ssh sftp ftp web websocket ws ui ux db sql nosql go rust java node python ruby swift kotlin scala php perl bash shell make cmake git github gitlab ci cd dev ops devops qa test tests testing build cache clean retry release version alpha bravo delta gamma theta omega company project product platform service wiki doc docs document documentation workflow router runtime security external internal design plan task bug decision context session config configuration authorization authentication observability validation integration implementation migration database data backfill safely feature flag rollout observation observations skill skills improvement improvements user users feedback from unified unification system summary transcription synchronization orchestration fixture ugnas ugcli horspowers group library lib module package client server frontend backend mobile desktop cloud storage network monitoring logging metrics alert audit review code source branch worktree team personal development deployment provision registry manifest inbox proposal change changes upgrade archive restore active completed disabled enabled stable latest legacy modern compatibility support supported core common shared public private local remote origin upstream staging production sandbox sample example examples demo demoapp starter template templates quick slow fast queue dispatch parallel agent agents collaboration review reviewer user-facing'.split(' ')
);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function countCodePoints(value) {
  return Array.from(value).length;
}

function exactObject(value, keys, pathname, errors) {
  if (!isPlainObject(value)) {
    errors.push({ path: pathname, code: 'object_required' });
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) errors.push({ path: `${pathname}.${key}`, code: 'unknown_field' });
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) errors.push({ path: `${pathname}.${key}`, code: 'required' });
  }
  return value;
}

function boundedText(value, min, max, pathname, errors, { noNewline = false } = {}) {
  if (typeof value !== 'string') {
    errors.push({ path: pathname, code: 'string_required' });
    return false;
  }
  const length = countCodePoints(value);
  if (length < min || length > max) {
    errors.push({ path: pathname, code: 'length_out_of_range' });
    return false;
  }
  if (value.includes('\0') || (noNewline && /[\r\n]/u.test(value))) {
    errors.push({ path: pathname, code: 'unsafe_text' });
    return false;
  }
  return true;
}

function boundedStringArray(value, minItems, maxItems, maxItemLength, pathname, errors) {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    errors.push({ path: pathname, code: 'array_length_out_of_range' });
    return [];
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      errors.push({ path: `${pathname}[${index}]`, code: 'array_item_required' });
      continue;
    }
    boundedText(value[index], 1, maxItemLength, `${pathname}[${index}]`, errors);
  }
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 240 || !FILE_PATH.test(value) ||
      value.startsWith('/') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..');
}

function safeCommandArgument(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > 240 ||
      /[\0\r\n`$;&|><]/u.test(value)) return false;
  return !/^(?:\/|~|[A-Za-z]:[\\/]|\\\\)/u.test(value);
}

function failure(errorCode, errors = []) {
  return { ok: false, error_code: errorCode, errors: errors.map(item => ({ path: item.path, code: item.code })) };
}

function textIssue(pathname, code) {
  return { path: pathname, code };
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function containsRawMarkdown(value) {
  return /```|~~~/u.test(value) ||
    /^(?: {4,}| {0,3}\t)/mu.test(value) ||
    /^\s*>/mu.test(value) ||
    /<[A-Za-z!/][^>]*>/u.test(value) ||
    /^\s{0,3}(?:#{1,6}\s|(?:[-+*]|\d+[.)])\s)/mu.test(value) ||
    /^\s{0,3}([*_-])(?:\s*\1){2,}\s*$/mu.test(value) ||
    /!?\[[^\]\n]{1,256}\]\([^\)\n]{1,1024}\)/u.test(value) ||
    /^\s*\[[^\]\n]{1,256}\]:\s*\S+/mu.test(value) ||
    /(^|[^\\])`[^`\n]+`/u.test(value) ||
    /^[^\n]+\n\s*(?:=|-){3,}\s*$/mu.test(value) ||
    /^\s*\|(?:[^|\n]*\|)+\s*$/mu.test(value);
}

function hasCopyableSourceSyntax(value) {
  return /^\s*(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\([^()\n]{0,400}\)\s*(?::\s*[^\n{]{1,160})?\s*\{/mu.test(value) ||
    /^\s*(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?\([^()\n]{0,400}\)\s*(?::\s*[^\n=]{1,160})?\s*=>/mu.test(value) ||
    /^\s*(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^()\n]{0,400}\)\s*(?:->\s*[^:\n]{1,160})?:/mu.test(value) ||
    /^\s*func\s+(?:\([^\n)]{1,160}\)\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\([^()\n]{0,400}\)[^{\n]{0,160}\{/mu.test(value) ||
    /^\s*(?:export\s+)?(?:class|interface|enum)\s+[A-Za-z_$][A-Za-z0-9_$]*[^\n{]{0,240}\{/mu.test(value) ||
    /^\s*(?:import\s+(?:[^\n]*\s+from\s+)?["'][^"'\n]+["']|from\s+[^\s\n]+\s+import\s+)/mu.test(value) ||
    /^\s*["'][A-Za-z0-9_.-]{1,128}["']\s*:\s*(?:["'[{\d-]|true\b|false\b|null\b)/mu.test(value);
}

function hasPatchShape(value) {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n');
  const hasOldHeader = lines.some(line => /^---(?:\s|$)/u.test(line));
  const hasNewHeader = lines.some(line => /^\+\+\+(?:\s|$)/u.test(line));
  return lines.some(line => /^@@(?:\s|$)/u.test(line)) ||
    (hasOldHeader && hasNewHeader) ||
    lines.some(line => /^[+-](?![+\-\s])\S/u.test(line));
}

function hasExternalUrl(value) {
  return /\b[A-Za-z][A-Za-z0-9+.-]{1,31}:\/\//u.test(value) || /\bmailto:/iu.test(value);
}

function hasCredentialAssignment(value) {
  return /(?:^|[^A-Za-z0-9_])(?:export\s+)?[A-Za-z_][A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|credential)[A-Za-z0-9_-]*\s*[:=]\s*\S+/iu.test(value);
}

function hasEnvironmentAssignment(value) {
  return /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]{0,127}\s*=\s*\S+/mu.test(value);
}

function isRelativePathToken(value) {
  return /^(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+$/u.test(value);
}

function hasHighEntropyCredential(value, ignoredTokens) {
  for (const match of value.matchAll(/[A-Za-z0-9+/_=-]{20,256}/gu)) {
    const candidate = match[0];
    const start = match.index ?? 0;
    const leadingToken = value.slice(0, start).match(/\S*$/u)?.[0] ?? '';
    const trailingToken = value.slice(start + candidate.length).match(/^\S*/u)?.[0] ?? '';
    const token = `${leadingToken}${candidate}${trailingToken}`;
    if (isRelativePathToken(token) || ignoredTokens?.has(token)) continue;
    if (entropy(candidate) >= HIGH_ENTROPY_THRESHOLD) return true;
  }
  return false;
}

function hasHighEntropyWindow(value) {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH || new Set(value).size < 12) return false;
  for (let start = 0; start <= value.length - HIGH_ENTROPY_MIN_LENGTH; start += 1) {
    const candidate = value.slice(start, start + HIGH_ENTROPY_MIN_LENGTH);
    if (entropy(candidate) >= HIGH_ENTROPY_THRESHOLD) return true;
  }
  return false;
}

function normalizedMetadataIdentifier(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC');
  // Metadata is protocol structure. Reject normalization changes and non-ASCII
  // text rather than silently scanning a different identifier than the one
  // eventually written to the Inbox.
  if (normalized !== value || /[^A-Za-z0-9._/-]/u.test(normalized)) return null;
  return normalized;
}

function isHumanReadableMetadataSlug(value) {
  const segments = value.toLowerCase().split(/[./-]/u);
  return segments.length > 1 && segments.every((segment) =>
    /^\d{1,4}$/u.test(segment) || /^v\d{1,4}$/u.test(segment) || HUMAN_READABLE_METADATA_TOKENS.has(segment)
  );
}

function isLowComplexityPadding(value, { allowTernaryShortPadding = false, allowBroadShortPadding = false } = {}) {
  if (value.length < LOW_COMPLEXITY_PADDING_MIN_LENGTH) return false;
  const distinct = new Set(value).size;
  // A three-character span has low Shannon entropy even when it is ordinary
  // prose (for example, "omp"), so short padding must visibly repeat. Longer
  // blocks may use a small fixed alphabet such as "abcdabcd".
  if (value.length === 3) return distinct <= (allowTernaryShortPadding ? 3 : 2);
  if (value.length === 4) return distinct <= (allowBroadShortPadding ? 4 : 3);
  if (allowBroadShortPadding) return distinct <= 5 && entropy(value) <= LOW_COMPLEXITY_PADDING_MAX_ENTROPY;
  if (value.length <= 7) return distinct <= 3 && entropy(value) <= 1.8;
  return distinct <= 5 && entropy(value) <= LOW_COMPLEXITY_PADDING_MAX_ENTROPY;
}

function removeRanges(value, ranges) {
  let cursor = 0;
  let output = '';
  for (const range of ranges) {
    if (range.start < cursor) continue;
    output += value.slice(cursor, range.start);
    cursor = range.end;
  }
  return output + value.slice(cursor);
}

function hasHighEntropyAfterRemovingRanges(value, ranges) {
  return ranges.length > 0 && hasHighEntropyWindow(removeRanges(value, ranges));
}

function hasHighEntropyAfterConstantPaddingCollapse(value) {
  if (new Set(value).size < 12) return false;
  const ranges = [];
  for (let start = 0; start < value.length;) {
    let end = start + 1;
    while (end < value.length && value[end] === value[start]) end += 1;
    if (end - start >= LOW_COMPLEXITY_PADDING_MIN_LENGTH) ranges.push({ start, end });
    start = end;
  }
  return ranges.some(range => hasHighEntropyAfterRemovingRanges(value, [range])) ||
    hasHighEntropyAfterRemovingRanges(value, ranges);
}

function hasHighEntropyAfterPairCollapse(value) {
  if (new Set(value).size < 12) return false;
  for (let start = 0; start <= value.length - PAIRED_IDENTIFIER_MIN_PAIRS * 2;) {
    if (value[start] !== value[start + 1]) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < value.length && value[end] === value[end + 1]) end += 2;
    if ((end - start) / 2 >= PAIRED_IDENTIFIER_MIN_PAIRS) {
      let collapsed = '';
      for (let index = start; index < end; index += 2) collapsed += value[index];
      if (hasHighEntropyWindow(`${value.slice(0, start)}${collapsed}${value.slice(end)}`)) return true;
    }

    // Advance beyond the complete paired run. A candidate beginning at its
    // second character cannot itself be a pair, so this remains linear.
    start = end;
  }
  return false;
}

function hasHighEntropyAfterSingletonInterleaveCollapse(value) {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH * 2 || new Set(value).size < 12) return false;
  for (const carrierOffset of [0, 1]) {
    let carrier = '';
    let padding = '';
    for (let index = 0; index < value.length; index += 1) {
      if (index % 2 === carrierOffset) carrier += value[index];
      else padding += value[index];
    }
    if (carrier.length < HIGH_ENTROPY_MIN_LENGTH || padding.length < HIGH_ENTROPY_MIN_LENGTH ||
        entropy(padding) > SINGLETON_INTERLEAVE_PADDING_MAX_ENTROPY) continue;
    if (hasHighEntropyWindow(carrier)) return true;
  }
  return false;
}

function hasHighEntropyAfterPeriodicInterleaveCollapse(value, options = {}) {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH + LOW_COMPLEXITY_PADDING_MIN_LENGTH || new Set(value).size < 12) return false;
  for (let carrierLength = 1; carrierLength <= PERIODIC_INTERLEAVE_MAX_CARRIER_LENGTH; carrierLength += 1) {
    for (let paddingLength = LOW_COMPLEXITY_PADDING_MIN_LENGTH; paddingLength <= PERIODIC_INTERLEAVE_MAX_PADDING_LENGTH; paddingLength += 1) {
      if (value.length < carrierLength + paddingLength + 1) continue;
      let cursor = 0;
      const carrierParts = [];
      let paddingCount = 0;
      let valid = true;
      while (cursor + carrierLength <= value.length) {
        carrierParts.push(value.slice(cursor, cursor + carrierLength));
        cursor += carrierLength;
        if (cursor === value.length) break;
        if (cursor + paddingLength > value.length) {
          // Only a final short carrier is permitted. Treat a partial padding
          // block as an invalid layout rather than deleting arbitrary text.
          if (value.length - cursor < carrierLength) {
            carrierParts.push(value.slice(cursor));
            cursor = value.length;
          } else {
            valid = false;
          }
          break;
        }
        const padding = value.slice(cursor, cursor + paddingLength);
        if (!isLowComplexityPadding(padding, options)) {
          valid = false;
          break;
        }
        paddingCount += 1;
        cursor += paddingLength;
      }
      if (valid && cursor < value.length && value.length - cursor < carrierLength) {
        carrierParts.push(value.slice(cursor));
        cursor = value.length;
      }
      if (valid && paddingCount >= 1 && cursor === value.length && hasHighEntropyWindow(carrierParts.join(''))) return true;
    }
  }
  return false;
}

function decodeDecimalCharacterCodes(value, groupWidth, codeOffset) {
  let decoded = '';
  for (let index = codeOffset; index + 3 <= value.length; index += groupWidth) {
    const code = Number(value.slice(index, index + 3));
    if (!Number.isInteger(code) || code < 32 || code > 126) return null;
    decoded += String.fromCharCode(code);
  }
  return decoded;
}

function hasHighEntropyAfterDecimalCodeCollapse(value) {
  for (const match of value.matchAll(/(?:[a-z]\d{3}){20,}/gu)) {
    const decoded = decodeDecimalCharacterCodes(match[0], 4, 1);
    if (decoded !== null && hasHighEntropyWindow(decoded)) return true;
  }
  for (const match of value.matchAll(/(?:\d{3}){20,}/gu)) {
    const decoded = decodeDecimalCharacterCodes(match[0], 3, 0);
    if (decoded !== null && hasHighEntropyWindow(decoded)) return true;
  }
  return false;
}

function hasHighEntropyMetadataIdentifier(value) {
  if (Buffer.byteLength(value, 'utf8') > MAX_METADATA_IDENTIFIER_SCAN_BYTES) return true;
  const normalized = normalizedMetadataIdentifier(value);
  if (normalized === null) return true;
  const compact = normalized.replace(/[^A-Za-z0-9]/gu, '');
  // Human-readable terms are retained as terms, rather than treated as an
  // opaque stream merely because concatenating them raises Shannon entropy.
  // All non-semantic metadata remains subject to every decoding detector.
  if (isHumanReadableMetadataSlug(normalized)) return false;
  if (hasHighEntropyWindow(compact)) return true;
  return hasHighEntropyAfterDecimalCodeCollapse(compact) ||
    hasHighEntropyAfterConstantPaddingCollapse(compact) ||
    hasHighEntropyAfterPairCollapse(compact) ||
    hasHighEntropyAfterSingletonInterleaveCollapse(compact) ||
    hasHighEntropyAfterPeriodicInterleaveCollapse(compact, {
      allowTernaryShortPadding: true,
      allowBroadShortPadding: true
    });
}

function hasSplitHighEntropyProjectId(value) {
  return hasHighEntropyMetadataIdentifier(value);
}

function jsonByteLength(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Identify unsafe text shapes without exposing the matched text.  It is used
 * both on safe-document fields and once more after runtime serialization.
 */
function inspectSubmissionTextWithOptions(value, options = {}) {
  if (typeof value !== 'string') return { ok: false, category: 'text_required' };
  const serialized = options?.serialized === true;
  if (/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/iu.test(value)) return { ok: false, category: 'private_key' };
  if (/\bauthorization\s*:/iu.test(value) || /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/iu.test(value)) {
    return { ok: false, category: 'authorization' };
  }
  if (hasCredentialAssignment(value) || /\b(?:sk-(?:proj-)?|gh[pousr]_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/iu.test(value) ||
      /\bAKIA[0-9A-Z]{16}\b/u.test(value)) {
    return { ok: false, category: 'credential_pattern' };
  }
  if (hasEnvironmentAssignment(value)) return { ok: false, category: 'env_assignment' };
  if (!serialized && containsRawMarkdown(value)) {
    return { ok: false, category: 'raw_markup' };
  }
  if (!serialized && hasCopyableSourceSyntax(value)) return { ok: false, category: 'source_syntax' };
  if (hasExternalUrl(value)) return { ok: false, category: 'external_url' };
  if (hasPatchShape(value) || /Traceback \(/u.test(value) ||
      /\bat\s+(?:async\s+)?[A-Za-z0-9_$.]+\s+\([^()\n]+:\d+(?::\d+)?\)/u.test(value)) {
    return { ok: false, category: 'log_or_diff' };
  }
  if ((value.match(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\b.*$/gmu) ?? []).length >= 2 ||
      (value.match(/^[A-Za-z_][A-Za-z0-9_]{2,}\s*=.*$/gmu) ?? []).length >= 3) {
    return { ok: false, category: 'log_or_env_assignment' };
  }
  if (/["“][^"”\n]{120,}["”]/u.test(value)) return { ok: false, category: 'long_verbatim_quote' };
  if (options?.skipHighEntropyCredential !== true && hasHighEntropyCredential(value, options?.ignoredHighEntropyTokens)) {
    return { ok: false, category: 'high_entropy_credential' };
  }
  return { ok: true };
}

export function inspectSubmissionText(value) {
  return inspectSubmissionTextWithOptions(value);
}

export function inspectSubmissionMetadataIdentifier(value, { projectId = false } = {}) {
  const inspected = inspectSubmissionTextWithOptions(value, { skipHighEntropyCredential: true });
  if (!inspected.ok) return inspected;
  if (!projectId) {
    return hasHighEntropyMetadataIdentifier(value)
      ? { ok: false, category: 'high_entropy_credential' }
      : inspected;
  }

  if (value.split('/').some(component => hasHighEntropyMetadataIdentifier(component)) ||
      hasSplitHighEntropyProjectId(value)) {
    return { ok: false, category: 'high_entropy_credential' };
  }
  return inspected;
}

function collectSimilarityTexts(document) {
  const texts = [];
  document.sections.forEach((section, sectionIndex) => {
    section.paragraphs.forEach((value, index) => texts.push({ path: `$.sections[${sectionIndex}].paragraphs[${index}]`, value }));
    section.bullets.forEach((value, index) => texts.push({ path: `$.sections[${sectionIndex}].bullets[${index}]`, value }));
    section.implementation_specs.forEach((specification, specificationIndex) => {
      for (const field of ['inputs', 'outputs', 'rules', 'errors']) {
        specification[field].forEach((value, index) => {
          texts.push({ path: `$.sections[${sectionIndex}].implementation_specs[${specificationIndex}].${field}[${index}]`, value });
        });
      }
    });
    section.commands.forEach((command, commandIndex) => {
      texts.push({ path: `$.sections[${sectionIndex}].commands[${commandIndex}].expected`, value: command.expected });
    });
  });
  return texts;
}

function collectSafetyTexts(document) {
  const texts = [{ path: '$.title', value: document.title }];
  document.sections.forEach((section, sectionIndex) => {
    texts.push({ path: `$.sections[${sectionIndex}].heading`, value: section.heading });
    section.paragraphs.forEach((value, index) => texts.push({ path: `$.sections[${sectionIndex}].paragraphs[${index}]`, value }));
    section.bullets.forEach((value, index) => texts.push({ path: `$.sections[${sectionIndex}].bullets[${index}]`, value }));
    section.files.forEach((file, fileIndex) => {
      texts.push({ path: `$.sections[${sectionIndex}].files[${fileIndex}].path`, value: file.path });
    });
    section.implementation_specs.forEach((specification, specificationIndex) => {
      texts.push({
        path: `$.sections[${sectionIndex}].implementation_specs[${specificationIndex}].symbol`,
        value: specification.symbol
      });
      for (const field of ['inputs', 'outputs', 'rules', 'errors']) {
        specification[field].forEach((value, index) => {
          texts.push({ path: `$.sections[${sectionIndex}].implementation_specs[${specificationIndex}].${field}[${index}]`, value });
        });
      }
    });
    section.commands.forEach((command, commandIndex) => {
      command.args.forEach((value, index) => {
        texts.push({ path: `$.sections[${sectionIndex}].commands[${commandIndex}].args[${index}]`, value });
      });
      texts.push({ path: `$.sections[${sectionIndex}].commands[${commandIndex}].expected`, value: command.expected });
    });
  });
  return texts;
}

function escapeInline(value) {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_{}\[\]<>|])/gu, '\\$1')
    .replace(/^(\s*)#/gmu, '$1\\#');
}

function renderList(label, values) {
  if (values.length === 0) return '';
  return `\n${label}\n${values.map(value => `- ${escapeInline(value)}`).join('\n')}\n`;
}

function renderDocument(document) {
  let output = `# ${escapeInline(document.title)}\n`;
  document.sections.forEach((section) => {
    output += `\n## ${escapeInline(section.heading)}\n`;
    if (section.paragraphs.length > 0) output += `\n${section.paragraphs.map(escapeInline).join('\n\n')}\n`;
    output += renderList('### Key points', section.bullets);
    if (section.files.length > 0) {
      output += '\n### Files\n\n| Operation | Path |\n| --- | --- |\n';
      output += section.files.map(file => `| ${file.operation} | ${escapeInline(file.path)} |`).join('\n');
      output += '\n';
    }
    if (section.implementation_specs.length > 0) {
      output += '\n### Implementation constraints\n';
      section.implementation_specs.forEach((specification) => {
        output += `\n#### ${escapeInline(specification.symbol)}\n`;
        output += `- Kind: ${specification.kind}\n- Language: ${specification.language}\n`;
        output += renderList('Inputs:', specification.inputs);
        output += renderList('Outputs:', specification.outputs);
        output += renderList('Rules:', specification.rules);
        output += renderList('Errors:', specification.errors);
      });
    }
    if (section.commands.length > 0) {
      output += '\n### Verification commands\n';
      section.commands.forEach((command) => {
        const commandLine = [command.program, ...command.args].map(escapeInline).join(' ');
        output += `\n- ${commandLine}\n  - Expected: ${escapeInline(command.expected)}\n`;
      });
    }
  });
  if (document.references.length > 0) {
    output += '\n## Related documents\n';
    document.references.forEach(reference => {
      output += `- ${reference.document_type}: ${reference.logical_id}\n`;
    });
  }
  return output;
}

function unescapeInline(value) {
  if (typeof value !== 'string') return null;
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      output += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined || !'\\`*_{}[]<>|#'.includes(escaped)) return null;
    output += escaped;
    index += 1;
  }
  return output;
}

function parseList(payload) {
  if (!payload.endsWith('\n')) return null;
  const lines = payload.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.some(line => !line.startsWith('- '))) return null;
  const values = lines.map(line => unescapeInline(line.slice(2)));
  return values.some(value => value === null) ? null : values;
}

function nextSectionMarker(value, start) {
  const markers = [
    '\n### Key points\n',
    '\n### Files\n',
    '\n### Implementation constraints\n',
    '\n### Verification commands\n'
  ];
  let index = value.length;
  for (const marker of markers) {
    const found = value.indexOf(marker, start);
    if (found !== -1 && found < index) index = found;
  }
  return index;
}

function parseFiles(payload) {
  const header = '\n| Operation | Path |\n| --- | --- |\n';
  if (!payload.startsWith(header) || !payload.endsWith('\n')) return null;
  const lines = payload.slice(header.length, -1).split('\n');
  if (lines.length === 0) return null;
  const files = [];
  for (const line of lines) {
    const match = /^\| (create|modify|test|review) \| ([^|]*) \|$/u.exec(line);
    if (!match) return null;
    const filePath = unescapeInline(match[2]);
    if (filePath === null) return null;
    files.push({ operation: match[1], path: filePath });
  }
  return files;
}

function nextSpecificationBoundary(value, start) {
  const markers = ['\n#### ', '\nInputs:\n', '\nOutputs:\n', '\nRules:\n', '\nErrors:\n'];
  let index = value.length;
  for (const marker of markers) {
    const found = value.indexOf(marker, start);
    if (found !== -1 && found < index) index = found;
  }
  return index;
}

function parseSpecifications(payload) {
  const specifications = [];
  let position = 0;
  while (position < payload.length) {
    if (!payload.startsWith('\n#### ', position)) return null;
    const headingEnd = payload.indexOf('\n', position + 6);
    if (headingEnd === -1) return null;
    const symbol = unescapeInline(payload.slice(position + 6, headingEnd));
    if (symbol === null) return null;
    position = headingEnd + 1;

    const kindPrefix = '- Kind: ';
    const languagePrefix = '- Language: ';
    if (!payload.startsWith(kindPrefix, position)) return null;
    const kindEnd = payload.indexOf('\n', position + kindPrefix.length);
    if (kindEnd === -1) return null;
    const kind = payload.slice(position + kindPrefix.length, kindEnd);
    position = kindEnd + 1;
    if (!payload.startsWith(languagePrefix, position)) return null;
    const languageEnd = payload.indexOf('\n', position + languagePrefix.length);
    if (languageEnd === -1) return null;
    const language = payload.slice(position + languagePrefix.length, languageEnd);
    position = languageEnd + 1;

    const specification = { kind, language, symbol, inputs: [], outputs: [], rules: [], errors: [] };
    const fields = [
      ['Inputs', 'inputs'],
      ['Outputs', 'outputs'],
      ['Rules', 'rules'],
      ['Errors', 'errors']
    ];
    for (const [label, field] of fields) {
      const marker = `\n${label}:\n`;
      if (!payload.startsWith(marker, position)) continue;
      const listStart = position + marker.length;
      const listEnd = nextSpecificationBoundary(payload, listStart);
      const list = parseList(payload.slice(listStart, listEnd));
      if (list === null) return null;
      specification[field] = list;
      position = listEnd;
    }
    specifications.push(specification);
  }
  return specifications;
}

function parseCommands(payload) {
  const commands = [];
  let position = 0;
  while (position < payload.length) {
    if (!payload.startsWith('\n- ', position)) return null;
    const lineEnd = payload.indexOf('\n', position + 3);
    if (lineEnd === -1) return null;
    const tokens = payload.slice(position + 3, lineEnd).split(' ').map(unescapeInline);
    if (tokens.length === 0 || tokens.some(token => token === null || token.length === 0)) return null;
    const expectedPrefix = '  - Expected: ';
    if (!payload.startsWith(expectedPrefix, lineEnd + 1)) return null;
    const expectedStart = lineEnd + 1 + expectedPrefix.length;
    const next = payload.indexOf('\n- ', expectedStart);
    const expectedEnd = next === -1 ? payload.length : next;
    let expectedRaw = payload.slice(expectedStart, expectedEnd);
    if (expectedRaw.endsWith('\n')) expectedRaw = expectedRaw.slice(0, -1);
    const expected = unescapeInline(expectedRaw);
    if (expected === null) return null;
    commands.push({ program: tokens[0], args: tokens.slice(1), expected });
    position = expectedEnd;
  }
  return commands;
}

function parseSectionBody(body) {
  const firstMarker = nextSectionMarker(body, 0);
  const paragraphPayload = body.slice(0, firstMarker);
  const paragraphs = [];
  if (paragraphPayload !== '') {
    if (!paragraphPayload.startsWith('\n') || !paragraphPayload.endsWith('\n')) return null;
    const values = paragraphPayload.slice(1, -1).split('\n\n').map(unescapeInline);
    if (values.some(value => value === null || value.length === 0)) return null;
    paragraphs.push(...values);
  }

  const section = {
    paragraphs,
    bullets: [],
    files: [],
    implementation_specs: [],
    commands: []
  };
  let position = firstMarker;
  const seen = new Set();
  while (position < body.length) {
    const marker = [
      ['bullets', '\n### Key points\n'],
      ['files', '\n### Files\n'],
      ['implementation_specs', '\n### Implementation constraints\n'],
      ['commands', '\n### Verification commands\n']
    ].find(([, candidate]) => body.startsWith(candidate, position));
    if (!marker || seen.has(marker[0])) return null;
    seen.add(marker[0]);
    const [field, prefix] = marker;
    const payloadStart = position + prefix.length;
    const payloadEnd = nextSectionMarker(body, payloadStart);
    const payload = body.slice(payloadStart, payloadEnd);
    if (field === 'bullets') section.bullets = parseList(payload);
    else if (field === 'files') section.files = parseFiles(payload);
    else if (field === 'implementation_specs') section.implementation_specs = parseSpecifications(payload);
    else section.commands = parseCommands(payload);
    if (section[field] === null) return null;
    position = payloadEnd;
  }
  return section;
}

function parseReferences(payload) {
  if (payload === '') return [];
  if (!payload.endsWith('\n')) return null;
  const references = [];
  for (const line of payload.slice(0, -1).split('\n')) {
    const match = /^- ([a-z]+): ([a-z0-9][a-z0-9-]{0,80})$/u.exec(line);
    if (!match) return null;
    references.push({ document_type: match[1], logical_id: match[2] });
  }
  return references;
}

/**
 * Parse only Markdown emitted by renderDocument(). The parser is intentionally
 * exact: a parsed value is accepted only when re-rendering preserves every
 * byte. This lets session progress updates retain known safe documents while
 * refusing arbitrary existing Markdown rather than silently replacing it.
 */
export function parseCanonicalSafeDocument(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES ||
      !markdown.startsWith('# ') || !markdown.endsWith('\n')) return { ok: false };
  const titleEnd = markdown.indexOf('\n');
  if (titleEnd === -1) return { ok: false };
  const title = unescapeInline(markdown.slice(2, titleEnd));
  if (title === null) return { ok: false };

  const document = {
    schema_version: 1,
    format: 'safe-document',
    title,
    sections: [],
    references: []
  };
  let position = titleEnd + 1;
  while (position < markdown.length) {
    if (!markdown.startsWith('\n## ', position)) return { ok: false };
    const headingEnd = markdown.indexOf('\n', position + 4);
    if (headingEnd === -1) return { ok: false };
    const heading = unescapeInline(markdown.slice(position + 4, headingEnd));
    if (heading === null) return { ok: false };
    const nextHeading = markdown.indexOf('\n## ', headingEnd + 1);
    const bodyEnd = nextHeading === -1 ? markdown.length : nextHeading;
    const body = markdown.slice(headingEnd + 1, bodyEnd);
    if (heading === 'Related documents') {
      if (nextHeading !== -1) return { ok: false };
      const references = parseReferences(body);
      if (references === null) return { ok: false };
      document.references = references;
      position = bodyEnd;
      break;
    }
    const section = parseSectionBody(body);
    if (section === null) return { ok: false };
    document.sections.push({ heading, ...section });
    position = bodyEnd;
  }

  const validated = validateSafeDocument(document);
  if (!validated.ok || renderDocument(validated.document) !== markdown) return { ok: false };
  return { ok: true, document: validated.document };
}

/**
 * Strictly validate the schema-1 safe-document AST and return a renderer-ready
 * value.  This function does not scan project source; callers use the async
 * helper below for the complete safety gate.
 */
export function validateSafeDocument(content) {
  const errors = [];
  const astBytes = typeof content === 'object' && content !== null ? jsonByteLength(content) : null;
  if (astBytes === null || astBytes > MAX_AST_BYTES) {
    return failure('safe_document_required', [textIssue('$', 'content_too_large_or_invalid')]);
  }
  const root = exactObject(content, ['schema_version', 'format', 'title', 'sections', 'references'], '$', errors);
  if (!root) return failure('safe_document_required', errors);
  if (root.schema_version !== 1) errors.push(textIssue('$.schema_version', 'unsupported_version'));
  if (root.format !== 'safe-document') errors.push(textIssue('$.format', 'safe_document_required'));
  boundedText(root.title, 1, 160, '$.title', errors, { noNewline: true });

  if (!Array.isArray(root.sections) || root.sections.length < 1 || root.sections.length > 32) {
    errors.push(textIssue('$.sections', 'array_length_out_of_range'));
  }
  if (!Array.isArray(root.references) || root.references.length > 64) {
    errors.push(textIssue('$.references', 'array_length_out_of_range'));
  }
  if (errors.length > 0) return failure('safe_document_required', errors);

  let paragraphCodePoints = 0;
  let bulletCount = 0;
  let fileCount = 0;
  let specificationCount = 0;
  let commandCount = 0;
  let ruleAndErrorCount = 0;
  for (let sectionIndex = 0; sectionIndex < root.sections.length; sectionIndex += 1) {
    const section = root.sections[sectionIndex];
    const sectionPath = `$.sections[${sectionIndex}]`;
    const value = exactObject(section, ['heading', 'paragraphs', 'bullets', 'files', 'implementation_specs', 'commands'], sectionPath, errors);
    if (!value) continue;
    boundedText(value.heading, 1, 120, `${sectionPath}.heading`, errors, { noNewline: true });
    const paragraphs = boundedStringArray(value.paragraphs, 0, 12, 1000, `${sectionPath}.paragraphs`, errors);
    const bullets = boundedStringArray(value.bullets, 0, 30, 300, `${sectionPath}.bullets`, errors);
    paragraphCodePoints += paragraphs.reduce((total, item) => total + (typeof item === 'string' ? countCodePoints(item) : 0), 0);
    bulletCount += bullets.length;

    if (!Array.isArray(value.files)) errors.push(textIssue(`${sectionPath}.files`, 'array_required'));
    else for (let fileIndex = 0; fileIndex < value.files.length; fileIndex += 1) {
      const file = value.files[fileIndex];
      fileCount += 1;
      const filePath = `${sectionPath}.files[${fileIndex}]`;
      const entry = exactObject(file, ['operation', 'path'], filePath, errors);
      if (!entry) continue;
      if (!FILE_OPERATIONS.has(entry.operation)) errors.push(textIssue(`${filePath}.operation`, 'invalid_operation'));
      if (!safeRelativePath(entry.path)) errors.push(textIssue(`${filePath}.path`, 'invalid_relative_path'));
    }

    if (!Array.isArray(value.implementation_specs)) errors.push(textIssue(`${sectionPath}.implementation_specs`, 'array_required'));
    else for (let specificationIndex = 0; specificationIndex < value.implementation_specs.length; specificationIndex += 1) {
      const specification = value.implementation_specs[specificationIndex];
      specificationCount += 1;
      const specificationPath = `${sectionPath}.implementation_specs[${specificationIndex}]`;
      const entry = exactObject(specification, ['kind', 'language', 'symbol', 'inputs', 'outputs', 'rules', 'errors'], specificationPath, errors);
      if (!entry) continue;
      if (!SPEC_KINDS.has(entry.kind)) errors.push(textIssue(`${specificationPath}.kind`, 'invalid_kind'));
      if (!SPEC_LANGUAGES.has(entry.language)) errors.push(textIssue(`${specificationPath}.language`, 'invalid_language'));
      if (typeof entry.symbol !== 'string' || !SYMBOL.test(entry.symbol)) errors.push(textIssue(`${specificationPath}.symbol`, 'invalid_symbol'));
      boundedStringArray(entry.inputs, 0, 16, 160, `${specificationPath}.inputs`, errors);
      boundedStringArray(entry.outputs, 0, 16, 160, `${specificationPath}.outputs`, errors);
      const rules = boundedStringArray(entry.rules, 0, 24, 500, `${specificationPath}.rules`, errors);
      const specificationErrors = boundedStringArray(entry.errors, 0, 24, 500, `${specificationPath}.errors`, errors);
      ruleAndErrorCount += rules.length + specificationErrors.length;
    }

    if (!Array.isArray(value.commands)) errors.push(textIssue(`${sectionPath}.commands`, 'array_required'));
    else for (let commandIndex = 0; commandIndex < value.commands.length; commandIndex += 1) {
      const command = value.commands[commandIndex];
      commandCount += 1;
      const commandPath = `${sectionPath}.commands[${commandIndex}]`;
      const entry = exactObject(command, ['program', 'args', 'expected'], commandPath, errors);
      if (!entry) continue;
      if (!COMMAND_PROGRAMS.has(entry.program)) errors.push(textIssue(`${commandPath}.program`, 'invalid_program'));
      if (!Array.isArray(entry.args) || entry.args.length > 32) errors.push(textIssue(`${commandPath}.args`, 'array_length_out_of_range'));
      else for (let argumentIndex = 0; argumentIndex < entry.args.length; argumentIndex += 1) {
        const argument = entry.args[argumentIndex];
        if (!safeCommandArgument(argument)) errors.push(textIssue(`${commandPath}.args[${argumentIndex}]`, 'invalid_argument'));
      }
      boundedText(entry.expected, 1, 300, `${commandPath}.expected`, errors);
    }
  }

  for (let index = 0; index < root.references.length; index += 1) {
    const reference = root.references[index];
    const referencePath = `$.references[${index}]`;
    const entry = exactObject(reference, ['document_type', 'logical_id'], referencePath, errors);
    if (!entry) continue;
    if (!DOCUMENT_TYPES.has(entry.document_type)) errors.push(textIssue(`${referencePath}.document_type`, 'invalid_document_type'));
    if (typeof entry.logical_id !== 'string' || !LOGICAL_ID.test(entry.logical_id)) errors.push(textIssue(`${referencePath}.logical_id`, 'invalid_logical_id'));
  }

  if (paragraphCodePoints > 24_000) errors.push(textIssue('$.sections', 'paragraph_total_too_large'));
  if (bulletCount > 300) errors.push(textIssue('$.sections', 'bullet_total_too_large'));
  if (fileCount > 64) errors.push(textIssue('$.sections', 'file_total_too_large'));
  if (specificationCount > 64) errors.push(textIssue('$.sections', 'specification_total_too_large'));
  if (commandCount > 64) errors.push(textIssue('$.sections', 'command_total_too_large'));
  if (ruleAndErrorCount > 512) errors.push(textIssue('$.sections', 'rules_errors_total_too_large'));
  if (errors.length > 0) return failure('safe_document_required', errors);
  return { ok: true, document: root };
}

/**
 * Validate, source-scan, serialize, and post-scan a safe-document. All
 * failures intentionally expose only a class and AST location, never content.
 */
export async function validateAndSerializeSafeDocument(content, projectRoot, {
  sourceSimilarityGuard = scanSourceSimilarity
} = {}) {
  const validated = validateSafeDocument(content);
  if (!validated.ok) return validated;

  const safetyTexts = collectSafetyTexts(validated.document);
  for (const text of safetyTexts) {
    const inspected = inspectSubmissionTextWithOptions(text.value);
    if (!inspected.ok) return failure('submission_safety_blocked', [textIssue(text.path, inspected.category)]);
  }
  for (let index = 0; index < validated.document.references.length; index += 1) {
    const logicalId = validated.document.references[index].logical_id;
    const inspected = inspectSubmissionMetadataIdentifier(logicalId);
    if (!inspected.ok) {
      return failure('submission_safety_blocked', [textIssue(`$.references[${index}].logical_id`, inspected.category)]);
    }
  }
  const texts = collectSimilarityTexts(validated.document);
  let sourceResult;
  try {
    sourceResult = await sourceSimilarityGuard({ projectRoot, texts });
  } catch {
    return failure('source_scan_incomplete', [textIssue('$.sections', 'source_scan_incomplete')]);
  }
  if (!sourceResult?.ok) {
    const code = sourceResult?.error_code === 'raw_source_detected'
      ? 'raw_source_detected'
      : sourceResult?.error_code === 'source_scan_incomplete'
        ? 'source_scan_incomplete'
        : 'source_scan_incomplete';
    const knownPaths = new Set(texts.map(text => text.path));
    const matchedPath = Array.isArray(sourceResult?.paths)
      ? sourceResult.paths.find(pathname => typeof pathname === 'string' && knownPaths.has(pathname))
      : null;
    return failure(code, [textIssue(matchedPath ?? '$.sections', code)]);
  }

  const markdown = renderDocument(validated.document);
  if (Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
    return failure('safe_document_required', [textIssue('$', 'serialized_content_too_large')]);
  }
  const ignoredHighEntropyTokens = new Set(validated.document.references.map(reference => reference.logical_id));
  const inspected = inspectSubmissionTextWithOptions(markdown, { serialized: true, ignoredHighEntropyTokens });
  if (!inspected.ok) return failure('submission_safety_blocked', [textIssue('$', inspected.category)]);
  return { ok: true, markdown };
}

export const SAFE_DOCUMENT_LIMITS = Object.freeze({ maxAstBytes: MAX_AST_BYTES, maxMarkdownBytes: MAX_MARKDOWN_BYTES });
