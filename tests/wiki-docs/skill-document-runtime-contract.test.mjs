import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DOCUMENT_RUNTIME_RESULT_STATUSES } from '../../lib/document-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const execFileAsync = promisify(execFile);
const runtimeReference = 'horspowers:using-horspowers/references/document-runtime.md';
const dailyWorkflowSkills = [
  'brainstorming',
  'dispatching-parallel-agents',
  'document-management',
  'executing-plans',
  'finishing-a-development-branch',
  'requesting-code-review',
  'subagent-driven-development',
  'systematic-debugging',
  'test-driven-development',
  'writing-plans'
];

// This is deliberately an exact list.  Adding a directory or renaming a
// low-level implementation must not silently make a direct write acceptable.
const lowLevelWriteAllowlist = new Set([
  'lib/config-manager.js',
  'lib/docs-core.js',
  'lib/document-backends/local-docs-backend.mjs',
  'lib/inbox-submitter.mjs',
  'lib/project-initializer.mjs'
]);

// These established writers retain separate, bounded responsibilities (managed
// AGENTS content, ordinary-project upgrade compatibility, an ephemeral
// brainstorm helper, and Graphviz rendering). They remain explicit
// file-and-operation inventories rather than becoming a directory-level escape
// hatch; adding a new Node fs mutation to any one of them must fail this audit.
// They are not Task 7's temporary legacy exception.
const establishedNodeFsMutationInventories = new Map([
  ['lib/agents-managed-block.mjs', new Set([
    'node-fs-mutation:copyFile',
    'node-fs-mutation:mkdir',
    'node-fs-mutation:rename',
    'node-fs-mutation:writeFile'
  ])],
  ['lib/version-upgrade.js', new Set([
    'node-fs-mutation:mkdirSync',
    'node-fs-mutation:renameSync',
    'node-fs-mutation:writeFileSync'
  ])],
  ['skills/brainstorming/scripts/server.cjs', new Set([
    'node-fs-mutation:appendFileSync',
    'node-fs-mutation:mkdirSync',
    'node-fs-mutation:unlinkSync',
    'node-fs-mutation:writeFileSync'
  ])],
  ['skills/writing-skills/render-graphs.js', new Set([
    'node-fs-mutation:mkdirSync',
    'node-fs-mutation:writeFileSync'
  ])]
]);

const runtimeTextExtensions = new Set([
  '.bash', '.c', '.cc', '.cjs', '.cmd', '.coffee', '.cpp', '.cs', '.fish',
  '.go', '.h', '.java', '.js', '.json', '.jsx', '.lua', '.mjs', '.php',
  '.pl', '.ps1', '.py', '.rb', '.rs', '.sh', '.swift', '.toml', '.ts',
  '.tsx', '.yaml', '.yml', '.zsh'
]);
const ignoredAuditDirectories = new Set(['.git', '.worktrees', 'coverage', 'node_modules']);
const nodeFsMutationMethods = new Set([
  'appendFile', 'chmod', 'chown', 'copyFile', 'cp', 'createWriteStream',
  'fchmod', 'fchown', 'ftruncate', 'link', 'lchmod', 'lchown', 'lutimes',
  'mkdir', 'mkdtemp', 'open', 'rename', 'rm', 'rmdir', 'symlink', 'truncate',
  'unlink', 'utimes', 'write', 'writeFile', 'writev'
]);

const legacyDocumentOperationPatterns = [
  ['legacy-docs-discovery', /\bfind\b[^\n]*(?:\$\{?[^}\n]*(?:doc|metadata)[^}\n]*\}?|(?:^|[\s"'`])docs\/)/iu],
  ['shell-document-append', />>\s*["']?\$\{?[^}\n]*(?:doc|metadata)[^}\n]*\}?/iu],
  ['metadata-directory-write', /\bmkdir(?:Sync)?\b[^\n]*(?:\$\{?[^}\n]*(?:doc|metadata)[^}\n]*\}?|(?:^|[\s"'`])docs\/)/iu],
  ['metadata-file-write', /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?)\s*\([\s\S]{0,240}?(?:\$\{?[^}\n]*(?:doc|metadata)[^}\n]*\}?|(?:^|[\s"'`])docs\/)/iu],
  ['docs-core-archive', /\bnode\b[^\n]*(?:docs[_-]?core|docs-core\.js)[^\n]*\barchive\b/iu]
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return ignoredAuditDirectories.has(entry.name) ? [] : walk(target);
    return [target];
  }));
  return paths.flat();
}

function relative(file) {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

async function readRelative(file) {
  return readFile(path.join(repoRoot, file), 'utf8');
}

function isKnownRuntimeTextRelativePath(rel) {
  if (rel === 'tests' || rel.startsWith('tests/')) return false;
  const name = path.basename(rel);
  if (name === 'SKILL.md' || rel.startsWith('commands/') || rel.startsWith('agents/')) return true;
  return runtimeTextExtensions.has(path.extname(name).toLocaleLowerCase('en-US'));
}

async function isRuntimeTextPath(file) {
  const rel = relative(file);
  if (isKnownRuntimeTextRelativePath(rel)) return true;
  if (rel === 'tests' || rel.startsWith('tests/')) return false;
  return ((await stat(file)).mode & 0o111) !== 0;
}

function isNodeFsMutationMethod(method) {
  return nodeFsMutationMethods.has(method) ||
    (method.endsWith('Sync') && nodeFsMutationMethods.has(method.slice(0, -4)));
}

const identifierPattern = String.raw`[A-Za-z_$][\w$]*`;
const nodeFsModuleSpecifierPattern = String.raw`(?:node:)?fs(?:/promises)?`;
const callPropertyPattern = String.raw`(?:(?:\.|\?\.)\s*call|(?:\?\.)?\s*\[\s*(?:"call"|'call')\s*\])`;

function addToSet(set, value) {
  if (set.has(value)) return false;
  set.add(value);
  return true;
}

function createNodeFsBindings() {
  return {
    modules: new Set(),
    promises: new Set(),
    dynamicModules: new Set(),
    possibleModules: new Set(),
    dynamicProperties: new Set(),
    loaderAliases: new Set(),
    reflectGetAliases: new Set(),
    methods: new Map()
  };
}

function addNodeFsBinding(bindings, name, descriptor) {
  if (descriptor === 'module') return addToSet(bindings.modules, name);
  if (descriptor === 'promises') return addToSet(bindings.promises, name);
  if (descriptor === 'dynamic-module') return addToSet(bindings.dynamicModules, name);
  if (descriptor === 'possible-module') return addToSet(bindings.possibleModules, name);
  if (descriptor === 'dynamic-property') return addToSet(bindings.dynamicProperties, name);
  if (!descriptor.startsWith('method:')) return false;

  const method = descriptor.slice('method:'.length);
  const methods = bindings.methods.get(name) || new Set();
  const changed = addToSet(methods, method);
  bindings.methods.set(name, methods);
  return changed;
}

function descriptorsForNodeFsBinding(bindings, name) {
  const descriptors = [];
  if (bindings.modules.has(name)) descriptors.push('module');
  if (bindings.promises.has(name)) descriptors.push('promises');
  if (bindings.dynamicModules.has(name)) descriptors.push('dynamic-module');
  if (bindings.possibleModules.has(name)) descriptors.push('possible-module');
  if (bindings.dynamicProperties.has(name)) descriptors.push('dynamic-property');
  for (const method of bindings.methods.get(name) || []) descriptors.push(`method:${method}`);
  return descriptors;
}

function addReflectGetAlias(bindings, name) {
  return addToSet(bindings.reflectGetAliases, name);
}

function addNodeFsLoaderAlias(bindings, name) {
  return addToSet(bindings.loaderAliases, name);
}

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function findMatchingDelimiter(source, start, opening, closing) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripOuterParentheses(expression) {
  let stripped = expression.trim();
  while (true) {
    const awaitMatch = /^await\b\s*/u.exec(stripped);
    const prefix = awaitMatch ? 'await ' : '';
    const candidate = awaitMatch ? stripped.slice(awaitMatch[0].length).trim() : stripped;
    if (!candidate.startsWith('(')) break;
    const closing = findMatchingDelimiter(candidate, 0, '(', ')');
    if (closing !== candidate.length - 1) break;
    stripped = `${prefix}${candidate.slice(1, -1).trim()}`.trim();
  }
  return stripped;
}

function normalizeParenthesizedCallee(expression) {
  let normalized = stripOuterParentheses(expression);
  const continuation = new RegExp(
    String.raw`^\s*(?:(?:\?\.)?\s*\(|(?:\.|\?\.)\s*(?:${identifierPattern}|\[)|\[)`,
    'u'
  );

  while (normalized.startsWith('(')) {
    const closing = findMatchingDelimiter(normalized, 0, '(', ')');
    if (closing === -1) break;
    const callee = normalized.slice(1, closing).trim();
    const tail = normalized.slice(closing + 1);
    if (!callee || !continuation.test(tail)) break;
    normalized = `${callee}${tail}`;
  }
  return normalized;
}

function splitTopLevel(source, separator = ',') {
  const values = [];
  let start = 0;
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === separator && braces === 0 && brackets === 0 && parentheses === 0) {
      values.push(source.slice(start, index));
      start = index + 1;
    }
  }
  values.push(source.slice(start));
  return values;
}

function findTopLevelCharacter(source, expected) {
  const pieces = splitTopLevel(source, expected);
  if (pieces.length === 1) return -1;
  return pieces[0].length;
}

function stripDefaultBinding(value) {
  const [binding] = splitTopLevel(value, '=');
  const match = new RegExp(`^\\s*(${identifierPattern})\\s*$`, 'u').exec(binding);
  return match ? match[1] : null;
}

function parseObjectPattern(pattern, prefix = []) {
  const trimmed = pattern.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [];
  const body = trimmed.slice(1, -1);
  const bindings = [];

  for (const rawEntry of splitTopLevel(body)) {
    const entry = rawEntry.trim();
    if (!entry || entry.startsWith('...')) continue;
    const colonIndex = findTopLevelCharacter(entry, ':');
    if (colonIndex === -1) {
      const namedImport = new RegExp(`^(${identifierPattern})(?:\\s+as\\s+(${identifierPattern}))?(?:\\s*=.*)?$`, 'u').exec(entry);
      if (namedImport) bindings.push({ path: [...prefix, namedImport[1]], name: namedImport[2] || namedImport[1] });
      continue;
    }

    const property = entry.slice(0, colonIndex).trim();
    const value = entry.slice(colonIndex + 1).trim();
    if (!new RegExp(`^${identifierPattern}$`, 'u').test(property)) continue;
    if (value.startsWith('{')) {
      const closing = findMatchingDelimiter(value, 0, '{', '}');
      if (closing === value.length - 1) bindings.push(...parseObjectPattern(value, [...prefix, property]));
      continue;
    }
    const name = stripDefaultBinding(value);
    if (name) bindings.push({ path: [...prefix, property], name });
  }
  return bindings;
}

const dynamicNodeFsProperty = Symbol('dynamic-node-fs-property');

function parseNodeFsPropertyPath(tail) {
  const properties = [];
  let index = 0;

  while (index < tail.length) {
    while (/\s/u.test(tail[index] || '')) index += 1;
    if (index >= tail.length) return properties;

    if (tail.startsWith('?.', index)) index += 2;
    else if (tail[index] === '.') index += 1;
    else if (tail[index] !== '[') return null;

    while (/\s/u.test(tail[index] || '')) index += 1;
    if (tail[index] === '[') {
      const end = findMatchingDelimiter(tail, index, '[', ']');
      if (end === -1) {
        properties.push(dynamicNodeFsProperty);
        return properties;
      }
      const expression = tail.slice(index + 1, end).trim();
      const staticProperty = /^(?:"([^"\\]*)"|'([^'\\]*)')$/u.exec(expression);
      properties.push(staticProperty ? (staticProperty[1] ?? staticProperty[2]) : dynamicNodeFsProperty);
      index = end + 1;
      continue;
    }

    const property = new RegExp(`^${identifierPattern}`, 'u').exec(tail.slice(index));
    if (!property) return null;
    properties.push(property[0]);
    index += property[0].length;
  }
  return properties;
}

function resolveNodeFsDescriptors(descriptors, properties) {
  let resolved = new Set(descriptors);
  for (const property of properties) {
    const next = new Set();
    for (const descriptor of resolved) {
      if (descriptor === 'dynamic-property' || property === dynamicNodeFsProperty) next.add('dynamic-property');
      else if (descriptor === 'module' && property === 'promises') next.add('promises');
      else if ((descriptor === 'dynamic-module' || descriptor === 'possible-module') && property === 'promises') {
        next.add(descriptor);
      }
      else if ((descriptor === 'module' || descriptor === 'promises') && isNodeFsMutationMethod(property)) {
        next.add(`method:${property}`);
      } else if ((descriptor === 'dynamic-module' || descriptor === 'possible-module') && isNodeFsMutationMethod(property)) {
        next.add('dynamic-property');
      }
    }
    resolved = next;
    if (resolved.size === 0) break;
  }
  return [...resolved];
}

function parseStaticStringLiteral(expression) {
  const match = /^(?:"([^"\\]*)"|'([^'\\]*)')$/u.exec(expression.trim());
  return match ? (match[1] ?? match[2]) : null;
}

function parseNodeFsLoaderExpression(expression, bindings) {
  const normalized = normalizeParenthesizedCallee(expression);
  const loader = new RegExp(
    `^(?:await\\s+)?(?:\\(\\s*)*(${identifierPattern})\\s*(${callPropertyPattern})?\\s*(?:\\?\\.)?\\s*\\(`,
    'u'
  ).exec(normalized);
  if (!loader) return null;

  const loaderName = loader[1];
  const isDynamicImport = loaderName === 'import';
  const isRequire = loaderName === 'require' || bindings.loaderAliases.has(loaderName);
  if (!isDynamicImport && !isRequire) return null;

  const opening = loader[0].lastIndexOf('(');
  const end = findMatchingDelimiter(normalized, opening, '(', ')');
  if (end === -1) return null;

  const isCallInvocation = loader[2] !== undefined;
  const moduleSpecifierIndex = isCallInvocation ? 1 : 0;
  const source = splitTopLevel(normalized.slice(opening + 1, end))[moduleSpecifierIndex];
  const staticSpecifier = parseStaticStringLiteral(source || '');
  const tail = normalized.slice(end + 1);
  if (staticSpecifier && new RegExp(`^${nodeFsModuleSpecifierPattern}$`, 'u').test(staticSpecifier)) {
    return {
      descriptors: [isDynamicImport
        ? 'dynamic-module'
        : (staticSpecifier.endsWith('/promises') ? 'promises' : 'module')],
      tail
    };
  }
  return {
    descriptors: staticSpecifier === null ? ['possible-module'] : [],
    tail
  };
}

function parseReflectGetExpression(expression) {
  const normalized = normalizeParenthesizedCallee(expression);
  const dot = new RegExp(
    `^Reflect\\s*(?:\\.|\\?\\.)\\s*get\\s*(${callPropertyPattern})?\\s*(?:\\?\\.)?\\s*\\(`,
    'u'
  ).exec(normalized);
  const bracket = new RegExp(
    `^Reflect\\s*(?:\\?\\.)?\\s*\\[\\s*([^\\]\\r\\n]*)\\s*\\]\\s*(${callPropertyPattern})?\\s*(?:\\?\\.)?\\s*\\(`,
    'u'
  ).exec(normalized);
  const match = dot ?? bracket;
  if (!match) return null;

  const bracketProperty = bracket ? parseStaticStringLiteral(bracket[1]) : 'get';
  if (bracketProperty !== null && bracketProperty !== 'get') return null;

  const opening = match[0].lastIndexOf('(');
  const end = findMatchingDelimiter(normalized, opening, '(', ')');
  if (end === -1) return null;

  const values = splitTopLevel(normalized.slice(opening + 1, end));
  const argumentOffset = dot?.[1] !== undefined || bracket?.[2] !== undefined ? 1 : 0;
  const [target, property] = values.slice(argumentOffset, argumentOffset + 2);
  if (!target || !property) return null;
  return {
    target,
    property: bracketProperty === null
      ? dynamicNodeFsProperty
      : (parseStaticStringLiteral(property) ?? dynamicNodeFsProperty),
    tail: normalized.slice(end + 1)
  };
}

function isPotentialReflectGetAliasExpression(expression) {
  const trimmed = stripOuterParentheses(expression);
  if (/^Reflect\s*(?:\.|\?\.)\s*get\s*$/u.test(trimmed)) return true;
  const bracket = /^Reflect\s*(?:\?\.)?\s*\[\s*([^\]\r\n]*)\s*\]$/u.exec(trimmed);
  if (!bracket) return false;
  const property = parseStaticStringLiteral(bracket[1]);
  return property === null || property === 'get';
}

function parseReflectGetAliasExpression(expression, bindings) {
  const normalized = normalizeParenthesizedCallee(expression);
  const match = new RegExp(
    `^(${identifierPattern})\\s*(${callPropertyPattern})?\\s*(?:\\?\\.)?\\s*\\(`,
    'u'
  ).exec(normalized);
  if (!match || !bindings.reflectGetAliases.has(match[1])) return null;

  const opening = match[0].lastIndexOf('(');
  const end = findMatchingDelimiter(normalized, opening, '(', ')');
  if (end === -1) return null;

  const values = splitTopLevel(normalized.slice(opening + 1, end));
  const argumentOffset = match[2] !== undefined ? 1 : 0;
  const [target, property] = values.slice(argumentOffset, argumentOffset + 2);
  if (!target || !property) return null;
  return {
    target,
    property: parseStaticStringLiteral(property) ?? dynamicNodeFsProperty,
    tail: normalized.slice(end + 1)
  };
}

function resolveNodeFsProperties(descriptors, properties) {
  const resolved = resolveNodeFsDescriptors(descriptors, properties);
  if (resolved.length > 0 || properties.length === 0) return resolved;
  const wrapper = properties.at(-1);
  if (!['apply', 'bind', 'call'].includes(wrapper)) return resolved;
  return resolveNodeFsDescriptors(descriptors, properties.slice(0, -1));
}

function resolveNodeFsExpression(expression, bindings) {
  const trimmed = stripOuterParentheses(expression);
  const reflect = parseReflectGetExpression(trimmed) ?? parseReflectGetAliasExpression(trimmed, bindings);
  if (reflect) {
    const sourceDescriptors = resolveNodeFsExpression(reflect.target, bindings);
    const tail = parseNodeFsPropertyPath(reflect.tail);
    if (!tail) return [];
    return resolveNodeFsProperties(sourceDescriptors, [reflect.property, ...tail])
      .map((descriptor) => descriptor.startsWith('method:') ? 'dynamic-property' : descriptor);
  }

  const loader = parseNodeFsLoaderExpression(trimmed, bindings);
  let descriptors;
  let tail;

  if (loader) {
    descriptors = loader.descriptors;
    tail = loader.tail;
  } else {
    const bindingMatch = new RegExp(`^(${identifierPattern})([\\s\\S]*)$`, 'u').exec(trimmed);
    if (!bindingMatch) return [];
    descriptors = descriptorsForNodeFsBinding(bindings, bindingMatch[1]);
    tail = bindingMatch[2];
  }

  const properties = parseNodeFsPropertyPath(tail);
  if (!properties) return [];
  return resolveNodeFsProperties(descriptors, properties);
}

function readDeclarationExpression(source, start) {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = null;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '[') brackets += 1;
    else if (character === ']') brackets -= 1;
    else if (character === '(') parentheses += 1;
    else if (character === ')') parentheses -= 1;
    else if (character === ';' && braces === 0 && brackets === 0 && parentheses === 0) return source.slice(start, index);
    else if (character === '\n' && braces === 0 && brackets === 0 && parentheses === 0) return source.slice(start, index);
  }
  return source.slice(start);
}

function objectDestructuringDeclarations(content) {
  const declarations = [];
  const declarationPattern = /\b(?:const|let|var)\s+/gu;
  for (const match of content.matchAll(declarationPattern)) {
    let index = match.index + match[0].length;
    while (/\s/u.test(content[index] || '')) index += 1;
    if (content[index] !== '{') continue;
    const end = findMatchingDelimiter(content, index, '{', '}');
    if (end === -1) continue;
    let expressionStart = end + 1;
    while (/\s/u.test(content[expressionStart] || '')) expressionStart += 1;
    if (content[expressionStart] !== '=') continue;
    expressionStart += 1;
    declarations.push({
      pattern: content.slice(index, end + 1),
      expression: readDeclarationExpression(content, expressionStart)
    });
  }
  return declarations;
}

function simpleVariableDeclarations(content) {
  const declarations = [];
  const declarationPattern = new RegExp(
    String.raw`\b(?:const|let|var)\s+(${identifierPattern})\s*=\s*`,
    'gu'
  );
  for (const match of content.matchAll(declarationPattern)) {
    declarations.push({ name: match[1], expression: readDeclarationExpression(content, match.index + match[0].length) });
  }
  return declarations;
}

function addDestructuredNodeFsBindings(bindings, sourceDescriptors, pattern) {
  let changed = false;
  for (const entry of parseObjectPattern(pattern)) {
    for (const descriptor of resolveNodeFsDescriptors(sourceDescriptors, entry.path)) {
      changed = addNodeFsBinding(bindings, entry.name, descriptor) || changed;
    }
  }
  return changed;
}

function addDestructuredReflectGetAliases(bindings, expression, pattern) {
  if (!/^Reflect\s*$/u.test(stripOuterParentheses(expression))) return false;
  let changed = false;
  for (const entry of parseObjectPattern(pattern)) {
    if (entry.path.length === 1 && entry.path[0] === 'get') {
      changed = addReflectGetAlias(bindings, entry.name) || changed;
    }
  }
  return changed;
}

function addEsmNodeFsBindings(content, bindings) {
  const importPattern = new RegExp(
    String.raw`(?:^|\n)\s*import\s+([^\n;]+?)\s+from\s+['"](${nodeFsModuleSpecifierPattern})['"]`,
    'gu'
  );

  for (const match of content.matchAll(importPattern)) {
    const specifiers = match[1].trim();
    const sourceDescriptors = [match[2].endsWith('/promises') ? 'promises' : 'module'];
    if (specifiers.startsWith('* as ')) {
      const name = stripDefaultBinding(specifiers.slice('* as '.length));
      if (name) addNodeFsBinding(bindings, name, sourceDescriptors[0]);
      continue;
    }
    if (specifiers.startsWith('{')) {
      addDestructuredNodeFsBindings(bindings, sourceDescriptors, specifiers);
      continue;
    }

    const [defaultSpecifier, ...namedSpecifiers] = splitTopLevel(specifiers);
    const defaultName = stripDefaultBinding(defaultSpecifier);
    if (defaultName) addNodeFsBinding(bindings, defaultName, sourceDescriptors[0]);
    const named = namedSpecifiers.join(',').trim();
    if (named.startsWith('{')) addDestructuredNodeFsBindings(bindings, sourceDescriptors, named);
  }
}

function collectNodeFsBindings(content) {
  const bindings = createNodeFsBindings();
  addEsmNodeFsBindings(content, bindings);
  const simpleDeclarations = simpleVariableDeclarations(content);
  const objectDeclarations = objectDestructuringDeclarations(content);

  for (let pass = 0; pass < 32; pass += 1) {
    let changed = false;
    for (const declaration of simpleDeclarations) {
      const normalizedExpression = stripOuterParentheses(declaration.expression);
      if (/^require\s*$/u.test(normalizedExpression)) {
        changed = addNodeFsLoaderAlias(bindings, declaration.name) || changed;
      } else {
        const alias = new RegExp(`^(${identifierPattern})\\s*$`, 'u').exec(normalizedExpression);
        if (alias && bindings.loaderAliases.has(alias[1])) {
          changed = addNodeFsLoaderAlias(bindings, declaration.name) || changed;
        }
      }
      if (isPotentialReflectGetAliasExpression(normalizedExpression)) {
        changed = addReflectGetAlias(bindings, declaration.name) || changed;
      } else {
        const alias = new RegExp(`^(${identifierPattern})\\s*$`, 'u').exec(normalizedExpression);
        if (alias && bindings.reflectGetAliases.has(alias[1])) {
          changed = addReflectGetAlias(bindings, declaration.name) || changed;
        }
      }
      for (const descriptor of resolveNodeFsExpression(declaration.expression, bindings)) {
        changed = addNodeFsBinding(bindings, declaration.name, descriptor) || changed;
      }
    }
    for (const declaration of objectDeclarations) {
      changed = addDestructuredReflectGetAliases(bindings, declaration.expression, declaration.pattern) || changed;
      const sourceDescriptors = resolveNodeFsExpression(declaration.expression, bindings);
      changed = addDestructuredNodeFsBindings(bindings, sourceDescriptors, declaration.pattern) || changed;
    }
    if (!changed) break;
  }
  return bindings;
}

function addNodeFsMutationOperationIds(operationIds, descriptors) {
  for (const descriptor of descriptors) {
    if (descriptor.startsWith('method:')) operationIds.add(`node-fs-mutation:${descriptor.slice('method:'.length)}`);
    if (descriptor === 'dynamic-property') operationIds.add('node-fs-mutation:dynamic-property');
  }
}

function invokedPropertyPath(source, start) {
  const properties = [];
  let index = start;
  while (/\s/u.test(source[index] || '')) index += 1;
  while (source[index] === ')') {
    index += 1;
    while (/\s/u.test(source[index] || '')) index += 1;
  }

  while (index < source.length) {
    let optional = false;
    if (source.startsWith('?.', index)) {
      optional = true;
      index += 2;
    } else if (source[index] === '.') {
      index += 1;
    } else if (source[index] !== '[') {
      return null;
    }
    while (/\s/u.test(source[index] || '')) index += 1;

    if (source[index] === '[') {
      const end = findMatchingDelimiter(source, index, '[', ']');
      if (end === -1) return null;
      const property = parseStaticStringLiteral(source.slice(index + 1, end)) ?? dynamicNodeFsProperty;
      properties.push(property);
      index = end + 1;
    } else {
      const property = new RegExp(`^${identifierPattern}`, 'u').exec(source.slice(index));
      if (!property) return null;
      properties.push(property[0]);
      index += property[0].length;
    }

    while (/\s/u.test(source[index] || '')) index += 1;
    if (source.startsWith('?.(', index)) return properties;
    if (source[index] === '(') return properties;
    if (optional) return null;
  }
  return null;
}

function loaderExpressionStart(source, loaderStart) {
  const prefix = source.slice(0, loaderStart);
  const awaitMatch = /await\s*$/u.exec(prefix);
  return awaitMatch ? (awaitMatch.index ?? loaderStart) : loaderStart;
}

function addDirectLoaderMutationOperations(content, bindings, operationIds) {
  const names = ['require', 'import', ...bindings.loaderAliases]
    .map(escapeRegexLiteral)
    .join('|');
  const loaderPattern = new RegExp(
    `(?<![A-Za-z0-9_$])(?:\\(\\s*)*(?:${names})(?:\\s*${callPropertyPattern})?(?:\\s*\\))*(?:\\s*${callPropertyPattern})?\\s*(?:\\?\\.)?\\s*\\(`,
    'gu'
  );
  for (const match of content.matchAll(loaderPattern)) {
    const loaderStart = match.index ?? 0;
    const opening = loaderStart + match[0].lastIndexOf('(');
    const end = findMatchingDelimiter(content, opening, '(', ')');
    if (end === -1) continue;
    const expressionStart = loaderExpressionStart(content, loaderStart);
    const descriptors = resolveNodeFsExpression(content.slice(expressionStart, end + 1), bindings);
    if (descriptors.length === 0) continue;
    const properties = invokedPropertyPath(content, end + 1);
    if (!properties) continue;
    addNodeFsMutationOperationIds(operationIds, resolveNodeFsProperties(descriptors, properties));
  }
}

function addReflectGetInvocationOperations(content, bindings, operationIds) {
  const callees = [
    'Reflect\\s*(?:(?:\\.|\\?\\.)\\s*get|(?:\\?\\.)?\\s*\\[\\s*[^\\]\\r\\n]*\\])',
    ...[...bindings.reflectGetAliases].map(escapeRegexLiteral)
  ];
  for (const callee of callees) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_$])(?:\\(\\s*)*(?:${callee})(?:\\s*${callPropertyPattern})?(?:\\s*\\))*(?:\\s*${callPropertyPattern})?\\s*(?:\\?\\.)?\\s*\\(`,
      'gu'
    );
    for (const match of content.matchAll(pattern)) {
      const start = match.index ?? 0;
      const opening = start + match[0].lastIndexOf('(');
      const end = findMatchingDelimiter(content, opening, '(', ')');
      if (end === -1) continue;
      const invocation = content.slice(end + 1);
      if (!/^\s*(?:(?:\?\.)?\s*\(|(?:\.|\?\.)\s*(?:apply|bind|call)\s*\()/u.test(invocation)) continue;
      addNodeFsMutationOperationIds(operationIds, resolveNodeFsExpression(content.slice(start, end + 1), bindings));
    }
  }
}

function nodeFsMutationOperations(content) {
  const bindings = collectNodeFsBindings(content);
  const accessor = String.raw`(?:(?:\.|\?\.)\s*${identifierPattern}|(?:\?\.)?\s*\[[^\]\r\n]*\])`;
  const invocationPattern = new RegExp(
    String.raw`((?:\(\s*)*(?:\brequire\(\s*['"]${nodeFsModuleSpecifierPattern}['"]\s*\)|\b(?!require\b)${identifierPattern})(?:\s*${accessor})*(?:\s*\))*)\s*(?:\?\.)?\s*\(`,
    'gu'
  );
  const operationIds = new Set();

  for (const match of content.matchAll(invocationPattern)) {
    addNodeFsMutationOperationIds(operationIds, resolveNodeFsExpression(match[1], bindings));
  }
  addDirectLoaderMutationOperations(content, bindings, operationIds);
  addReflectGetInvocationOperations(content, bindings, operationIds);
  return [...operationIds].sort();
}

function legacyDocumentOperations(content) {
  return [...new Set([
    ...legacyDocumentOperationPatterns
      .filter(([, pattern]) => pattern.test(content))
      .map(([id]) => id),
    ...nodeFsMutationOperations(content)
  ])];
}

function auditRuntimeText(relativePath, content) {
  return {
    file: relativePath,
    operationIds: legacyDocumentOperations(content)
  };
}

test('daily workflow skills route document operations through the shared runtime', async () => {
  for (const skill of dailyWorkflowSkills) {
    const file = `skills/${skill}/SKILL.md`;
    const content = await readRelative(file);
    assert.match(content, new RegExp(runtimeReference.replaceAll('.', '\\.'), 'u'), file);
    assert.doesNotMatch(content, /\.horspowers-config\.yaml/u, `${file} must not select a document backend from a local marker`);
    assert.doesNotMatch(content, /(?:DocsCore|UnifiedDocsManager|lib\/docs-core\.js)/u, `${file} must not instantiate docs-core directly`);
    assert.doesNotMatch(content, /(?:find|cat|echo\s*>>|mv)\b[^\n]*(?:docs\/(?:plans|active|archive))/u, `${file} must not directly operate legacy document paths`);
  }
});

test('runtime reference documents JSON stdin contract, safe documents, and the runtime status catalog', async () => {
  const content = await readRelative('skills/using-horspowers/references/document-runtime.md');
  for (const action of ['resolve', 'get', 'search', 'create', 'update', 'archive', 'restore', 'config-change', 'record-session']) {
    assert.match(content, new RegExp(`\\b${action}\\b`, 'u'), `missing action: ${action}`);
  }
  assert.ok(DOCUMENT_RUNTIME_RESULT_STATUSES.includes('invalid_request'));
  assert.ok(DOCUMENT_RUNTIME_RESULT_STATUSES.includes('context_unavailable'));
  assert.ok(DOCUMENT_RUNTIME_RESULT_STATUSES.includes('documentation_disabled'));
  assert.ok(DOCUMENT_RUNTIME_RESULT_STATUSES.includes('wiki_backend_unavailable'));
  assert.equal(new Set(DOCUMENT_RUNTIME_RESULT_STATUSES).size, DOCUMENT_RUNTIME_RESULT_STATUSES.length);
  for (const status of DOCUMENT_RUNTIME_RESULT_STATUSES) {
    assert.match(content, new RegExp(`\\b${status}\\b`, 'u'), `missing result state: ${status}`);
  }
  assert.match(content, /safe-document/u);
  assert.match(content, /implementation_specs/u);
  assert.match(content, /stdin/u);
  assert.match(content, /argv/u);
});

test('read and write workflow contracts retain their workflow gates through runtime actions', async () => {
  const expectedActions = {
    'executing-plans': ['search', 'get'],
    'requesting-code-review': ['search', 'get'],
    'dispatching-parallel-agents': ['search', 'get'],
    'subagent-driven-development': ['search', 'get'],
    brainstorming: ['search', 'create', 'update'],
    'writing-plans': ['search', 'create', 'update'],
    'systematic-debugging': ['search', 'create', 'update'],
    'test-driven-development': ['create', 'update'],
    'finishing-a-development-branch': ['get', 'update', 'archive'],
    'document-management': ['resolve', 'get', 'search', 'create', 'update', 'archive', 'restore', 'config-change']
  };

  for (const [skill, actions] of Object.entries(expectedActions)) {
    const content = await readRelative(`skills/${skill}/SKILL.md`);
    for (const action of actions) {
      assert.match(content, new RegExp(`\\b${action}\\b`, 'u'), `${skill} missing runtime ${action}`);
    }
  }

  const brainstorming = await readRelative('skills/brainstorming/SKILL.md');
  const writingPlans = await readRelative('skills/writing-plans/SKILL.md');
  const tdd = await readRelative('skills/test-driven-development/SKILL.md');
  const review = await readRelative('skills/requesting-code-review/SKILL.md');
  const finishing = await readRelative('skills/finishing-a-development-branch/SKILL.md');
  const subagentDevelopment = await readRelative('skills/subagent-driven-development/SKILL.md');
  assert.match(brainstorming, /spec-document-reviewer-prompt\.md/u);
  assert.match(writingPlans, /plan-document-reviewer-prompt\.md/u);
  assert.match(tdd, /RED-GREEN-REFACTOR/u);
  assert.match(review, /review/u);
  assert.match(finishing, /tests pass|测试通过/u);
  assert.match(subagentDevelopment, /全部任务完成后[\s\S]*最终全量 diff[\s\S]*独立.*code review/u);
  assert.match(subagentDevelopment, /blocking.*修复.*复审[\s\S]*finishing/u);
});

test('repository audit rejects direct document operations outside the exact allowlist', async () => {
  assert.equal(lowLevelWriteAllowlist.has('scripts/migrate-docs.js'), false);
  assert.equal(establishedNodeFsMutationInventories.has('scripts/migrate-docs.js'), false);
  const allFiles = await walk(repoRoot);
  const textFlags = await Promise.all(allFiles.map(isRuntimeTextPath));
  const files = allFiles.filter((_, index) => textFlags[index]);
  const violations = [];

  for (const file of files) {
    const rel = relative(file);
    const content = await readFile(file, 'utf8');
    const { operationIds } = auditRuntimeText(rel, content);
    if (operationIds.length === 0 || lowLevelWriteAllowlist.has(rel)) continue;

    const establishedInventory = establishedNodeFsMutationInventories.get(rel);
    if (establishedInventory) {
      assert.deepEqual(new Set(operationIds), establishedInventory, `${rel} must not gain an unreviewed Node fs mutation`);
      continue;
    }

    violations.push({ file: rel, operationIds });
  }

  assert.deepEqual(violations, []);
});

test('audit recognizes indirect document variables and includes .cjs candidates', () => {
  assert.equal(isKnownRuntimeTextRelativePath('hooks/legacy-session.cjs'), true);
  const content = [
    'find "$project_docs_dir" -name "*.md"',
    'printf "%s" "$record" >> "$doc_path"',
    'mkdir -p "$metadata_dir"',
    'fs.writeFileSync(\n  `${metadata_dir}/last-session.json`, payload\n)',
    'node "$docs_core" archive "$doc_file"'
  ].join('\n');

  assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
    'legacy-docs-discovery',
    'shell-document-append',
    'metadata-directory-write',
    'metadata-file-write',
    'docs-core-archive'
  ]));

  assert.deepEqual(new Set(legacyDocumentOperations(
    'fs.mkdirSync(`${metadata_dir}/events`, { recursive: true });'
  )), new Set(['metadata-directory-write']));
});

test('audit recognizes Node fs mutations through generic CJS bindings and property paths', () => {
  assert.equal(isKnownRuntimeTextRelativePath('scripts/legacy-migration.cjs'), true);
  const content = [
    "const fileSystem = require('node:fs');",
    "const disk = require('fs');",
    'fileSystem.mkdirSync(path.dirname(rename.target), { recursive: true });',
    'fileSystem.renameSync(rename.source, rename.target);',
    'fileSystem.appendFileSync(merge.design, content);',
    'fileSystem.unlinkSync(merge.decision);',
    'disk.promises.writeFile(update.file, content);'
  ].join('\n');

  assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
    'node-fs-mutation:appendFileSync',
    'node-fs-mutation:mkdirSync',
    'node-fs-mutation:renameSync',
    'node-fs-mutation:unlinkSync',
    'node-fs-mutation:writeFile'
  ]));
});

test('audit follows Node fs method aliases and static property access', () => {
  const cases = [
    [
      "const storage = require('node:fs');",
      "const save = storage['writeFileSync'];",
      'save(update.file, content);'
    ].join('\n'),
    [
      "const { mkdirSync: makeDirectory } = require('fs');",
      'makeDirectory(path.dirname(rename.target), { recursive: true });'
    ].join('\n'),
    [
      "const save = require('node:fs')['writeFileSync'];",
      "const target = path.join('docs', 'active', 'task.md');",
      'save(target, content);'
    ].join('\n'),
    [
      "import { createWriteStream as createWriter } from 'node:fs';",
      'createWriter(update.file);'
    ].join('\n')
  ];

  const expectedOperationIds = [
    'node-fs-mutation:writeFileSync',
    'node-fs-mutation:mkdirSync',
    'node-fs-mutation:writeFileSync',
    'node-fs-mutation:createWriteStream'
  ];

  for (const [index, content] of cases.entries()) {
    assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
      expectedOperationIds[index]
    ]));
  }
});

test('audit fails closed on dynamic Node fs properties and their aliases', () => {
  const cases = [
    [
      "const fileSystem = require('node:fs');",
      'fileSystem[method](record.target, content);'
    ].join('\n'),
    [
      "const fileSystem = require('node:fs');",
      "const persist = fileSystem['write' + 'FileSync'];",
      'const retryPersist = persist;',
      'retryPersist(record.target, content);'
    ].join('\n'),
    [
      "const fileSystem = require('fs');",
      'const disk = fileSystem;',
      'disk[method](record.target, content);'
    ].join('\n')
  ];

  for (const content of cases) {
    assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
      'node-fs-mutation:dynamic-property'
    ]));
  }

});

test('audit fails closed on dynamic module loading and Reflect fs access without flagging unrelated modules', () => {
  const dynamicCases = [
    [
      "const disk = await import('node:fs');",
      "disk.writeFileSync(record.target, 'unsafe');"
    ].join('\n'),
    [
      "const disk = require('node:' + 'fs');",
      "disk.writeFileSync(record.target, 'unsafe');"
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'Reflect.get(disk, method)(record.target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "Reflect.get(disk, 'writeFileSync')(record.target, content);"
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const persist = Reflect.get(disk, method);',
      'const retryPersist = persist;',
      'retryPersist(record.target, content);'
    ].join('\n'),
    [
      'const disk = require(moduleSpecifier);',
      "disk.writeFileSync(record.target, 'unsafe');"
    ].join('\n'),
    [
      'const disk = await import(moduleSpecifier);',
      "disk.writeFileSync(record.target, 'unsafe');"
    ].join('\n'),
    [
      'const disk = (require(moduleSpecifier));',
      "disk.writeFileSync(record.target, 'unsafe');"
    ].join('\n'),
    [
      'const disk = await (import(moduleSpecifier));',
      "disk.writeFileSync(record.target, 'unsafe');"
    ].join('\n')
  ];

  for (const [index, content] of dynamicCases.entries()) {
    assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
      'node-fs-mutation:dynamic-property'
    ]), `dynamic case ${index}`);
  }

  const unrelatedDynamicModule = [
    'const plugin = require(moduleSpecifier);',
    'plugin.run(record);',
    'const renderer = await import(rendererSpecifier);',
    'renderer.render(record);',
    'const wrappedPlugin = (require(moduleSpecifier));',
    'wrappedPlugin.run(record);',
    'const wrappedRenderer = await (import(rendererSpecifier));',
    'wrappedRenderer.render(record);'
  ].join('\n');
  assert.deepEqual(legacyDocumentOperations(unrelatedDynamicModule), []);

});

test('audit fails closed on direct Node fs loaders and Reflect.get aliases', () => {
  const cases = [
    'require(moduleSpecifier).writeFileSync(target, content);',
    "(await import('node:fs')).writeFileSync(target, content);",
    "(require('node:' + 'fs')).writeFileSync(target, content);",
    '(require)(moduleSpecifier).writeFileSync(target, content);',
    'require?.(moduleSpecifier).writeFileSync(target, content);',
    'require.call(null, moduleSpecifier).writeFileSync(target, content);',
    [
      'const load = require;',
      'load(moduleSpecifier).writeFileSync(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const get = Reflect.get;',
      'get(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const $get = Reflect.get;',
      '$get(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "Reflect['get'](disk, method)(target, content);"
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "const get = Reflect['get'];",
      'get(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'Reflect.get.call(Reflect, disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const { get } = Reflect;',
      'get(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const { get } = (Reflect);',
      'get(disk, method)(target, content);'
    ].join('\n')
  ];

  for (const [index, content] of cases.entries()) {
    assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
      'node-fs-mutation:dynamic-property'
    ]), `direct loader or Reflect alias case ${index}`);
  }

  const unrelatedDynamicModule = [
    'require(moduleSpecifier).run(target, content);',
    '(await import(moduleSpecifier)).render(target, content);'
  ].join('\n');
  assert.deepEqual(legacyDocumentOperations(unrelatedDynamicModule), []);

});

test('audit reads loader call specifiers after thisArgs and follows parenthesized aliases', () => {
  const loaderCallCases = [
    [
      "require.call('node:path', moduleSpecifier).writeFileSync(target, content);",
      ['node-fs-mutation:dynamic-property']
    ],
    [
      "require.call('node:path', 'node:fs').writeFileSync(target, content);",
      ['node-fs-mutation:writeFileSync']
    ],
    [
      "require.call('node:fs', 'node:path').writeFileSync(target, content);",
      []
    ]
  ];

  for (const [index, [content, expectedOperationIds]] of loaderCallCases.entries()) {
    assert.deepEqual(
      new Set(legacyDocumentOperations(content)),
      new Set(expectedOperationIds),
      `loader call case ${index}`
    );
  }

  const parenthesizedAliasCases = [
    [
      'const load = (require);',
      'load(moduleSpecifier).writeFileSync(target, content);'
    ].join('\n'),
    [
      'const $load = (require);',
      '$load(moduleSpecifier).writeFileSync(target, content);'
    ].join('\n'),
    [
      'const $load = (require);',
      'const next = ($load);',
      'next(moduleSpecifier).writeFileSync(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const get = (Reflect.get);',
      'get(disk, method)(target, content);'
    ].join('\n')
  ];

  for (const [index, content] of parenthesizedAliasCases.entries()) {
    assert.deepEqual(
      new Set(legacyDocumentOperations(content)),
      new Set(['node-fs-mutation:dynamic-property']),
      `parenthesized alias case ${index}`
    );
  }
});

test('audit fails closed on parenthesized and optional Reflect.get invocations', () => {
  const cases = [
    [
      "const disk = require('node:fs');",
      '(Reflect.get)(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "(Reflect['get'])(disk, method)(target, content);"
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'Reflect.get?.(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "Reflect['get']?.(disk, method)(target, content);"
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const get = Reflect.get;',
      '(get)(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "const get = Reflect['get'];",
      '(get)(disk, method)(target, content);'
    ].join('\n')
  ];

  for (const [index, content] of cases.entries()) {
    assert.deepEqual(
      new Set(legacyDocumentOperations(content)),
      new Set(['node-fs-mutation:dynamic-property']),
      `parenthesized or optional Reflect.get case ${index}`
    );
  }

  const unrelatedModule = [
    "const path = require('node:path');",
    '(Reflect.get)(path, method)(target, content);'
  ].join('\n');
  assert.deepEqual(legacyDocumentOperations(unrelatedModule), []);
});

test('audit fails closed on optional Reflect property access and aliases', () => {
  const cases = [
    [
      "const disk = require('node:fs');",
      'Reflect?.get(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "Reflect?.['get'](disk, method)(target, content);"
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      '(Reflect?.get)(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "(Reflect?.['get'])(disk, method)(target, content);"
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'Reflect?.get?.(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "Reflect?.['get']?.(disk, method)(target, content);"
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const get = Reflect?.get;',
      '(get)(disk, method)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      "const get = Reflect?.['get'];",
      '(get)(disk, method)(target, content);'
    ].join('\n')
  ];

  for (const [index, content] of cases.entries()) {
    assert.deepEqual(
      new Set(legacyDocumentOperations(content)),
      new Set(['node-fs-mutation:dynamic-property']),
      `optional Reflect property access case ${index}`
    );
  }

  const unrelatedModuleCases = [
    [
      "const path = require('node:path');",
      'Reflect?.get(path, method)(target, content);'
    ].join('\n'),
    [
      "const path = require('node:path');",
      "Reflect?.['get']?.(path, method)(target, content);"
    ].join('\n')
  ];
  for (const content of unrelatedModuleCases) {
    assert.deepEqual(legacyDocumentOperations(content), []);
  }
});

test('audit reads optional, parenthesized, and bracketed loader call specifiers after thisArgs', () => {
  const callForms = [
    'require?.call',
    '(require.call)',
    "require['call']",
    "require?.['call']",
    "(require['call'])",
    '(require)?.call',
    'require.call?.'
  ];

  for (const [index, callee] of callForms.entries()) {
    const dynamicModule = callee + '(null, moduleSpecifier).writeFileSync(target, content);';
    assert.deepEqual(
      new Set(legacyDocumentOperations(dynamicModule)),
      new Set(['node-fs-mutation:dynamic-property']),
      `dynamic loader call form ${index}`
    );

    const nodeFsModule = callee + "('node:path', 'node:fs').writeFileSync(target, content);";
    assert.deepEqual(
      new Set(legacyDocumentOperations(nodeFsModule)),
      new Set(['node-fs-mutation:writeFileSync']),
      `static loader call form ${index}`
    );

    const nonFsModule = callee + "('node:fs', 'node:path').writeFileSync(target, content);";
    assert.deepEqual(
      legacyDocumentOperations(nonFsModule),
      [],
      `loader call thisArg must not become its module specifier: ${index}`
    );
  }
});

test('audit applies Node fs mutation detection to every runtime text path, including hook .cjs files', () => {
  const relativePath = 'hooks/legacy-document-writer.cjs';
  assert.equal(isKnownRuntimeTextRelativePath(relativePath), true);
  const content = [
    "const fileSystem = require('node:fs');",
    "fileSystem['writeFileSync'](record.target, 'unsafe');"
  ].join('\n');

  assert.deepEqual(new Set(auditRuntimeText(relativePath, content).operationIds), new Set([
    'node-fs-mutation:writeFileSync'
  ]));
});

test('audit resolves CJS and ESM fs aliases, nested destructuring, and promises access paths', () => {
  const cases = [
    [
      "const sourceFs = require('node:fs');",
      'const disk = sourceFs;',
      "disk.writeFileSync(record.target, 'unsafe');"
    ].join('\n'),
    [
      "const { promises: { writeFile: persist } } = require('node:fs');",
      "persist(record.target, 'unsafe');"
    ].join('\n'),
    [
      "import fileSystem, { writeFile as persist } from 'node:fs';",
      'const disk = fileSystem;',
      'disk.mkdirSync(record.directory, { recursive: true });',
      "persist(record.target, 'unsafe');"
    ].join('\n'),
    [
      "const fileSystem = require('fs');",
      "fileSystem['promises']['writeFile'](record.target, 'unsafe');"
    ].join('\n'),
    "require('fs').promises.writeFile(record.target, 'unsafe');",
    [
      "const persist = require('fs').promises.writeFile;",
      "persist(record.target, 'unsafe');"
    ].join('\n')
  ];

  const expectedOperationIds = [
    ['node-fs-mutation:writeFileSync'],
    ['node-fs-mutation:writeFile'],
    ['node-fs-mutation:mkdirSync', 'node-fs-mutation:writeFile'],
    ['node-fs-mutation:writeFile'],
    ['node-fs-mutation:writeFile'],
    ['node-fs-mutation:writeFile']
  ];

  for (const [index, content] of cases.entries()) {
    assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set(expectedOperationIds[index]));
  }
});

test('audit recognizes parenthesized fs method calls without flagging non-fs aliases', () => {
  const fsCases = [
    [
      "const disk = require('node:fs');",
      '(disk.writeFileSync)(target, content);'
    ].join('\n'),
    [
      "const disk = require('node:fs');",
      'const persist = disk.writeFileSync;',
      '(persist)(target, content);'
    ].join('\n')
  ];

  for (const [index, content] of fsCases.entries()) {
    assert.deepEqual(new Set(legacyDocumentOperations(content)), new Set([
      'node-fs-mutation:writeFileSync'
    ]), `parenthesized fs call case ${index}`);
  }

  const nonFs = [
    "const path = require('node:path');",
    'const join = path.join;',
    '(join)(target, content);'
  ].join('\n');
  assert.deepEqual(legacyDocumentOperations(nonFs), []);
});

test('Session hooks are thin runtime wrappers without a deferred legacy write exception', async () => {
  for (const hook of ['hooks/session-start.sh', 'hooks/session-end.sh']) {
    const content = await readRelative(hook);
    assert.match(content, /session-hook-runtime\.mjs/u, `${hook} must delegate to the shared hook runtime`);
    assert.deepEqual(legacyDocumentOperations(content), [], `${hook} must not retain direct document operations`);
  }
});

test('upgrade entry is explicitly fail-closed for external-document projects', async () => {
  const upgradeSkill = await readRelative('skills/upgrade/SKILL.md');
  const upgradeCode = await readRelative('lib/version-upgrade.js');
  assert.match(upgradeSkill, /external_project_upgrade_disabled/u);
  assert.match(upgradeSkill, /外置配置注册/u);
  assert.match(upgradeCode, /identifyGitProject/u);
  assert.match(upgradeCode, /external_project_upgrade_disabled/u);
  assert.match(upgradeCode, /no_mutation/u);
});
