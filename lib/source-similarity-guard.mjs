import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxWallMs: 5_000
});
const WINDOW_CODE_POINTS = 20;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedLimits(value = {}) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some(key => !Object.hasOwn(DEFAULT_LIMITS, key))) return null;
  const limits = { ...DEFAULT_LIMITS, ...value };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_LIMITS[key]) return null;
  }
  return limits;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || path.isAbsolute(value)) return false;
  const segments = value.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..');
}

function normalizeLine(value) {
  return value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim().replace(/\s+/gu, ' ');
}

function normalizedLines(value) {
  return value.replace(/\r\n?/gu, '\n').split('\n').map(normalizeLine).filter(Boolean);
}

function codePoints(value) {
  return Array.from(value);
}

function sourceMatch(candidate, sourceNormalized, startedAt, limits) {
  if (!withinDeadline(startedAt, limits)) return null;
  for (const line of normalizedLines(candidate)) {
    if (!withinDeadline(startedAt, limits)) return null;
    const points = codePoints(line);
    if (points.length < WINDOW_CODE_POINTS) continue;
    if (sourceNormalized.includes(line)) return true;
    for (let index = 0; index <= points.length - WINDOW_CODE_POINTS; index += 1) {
      if (index % 64 === 0 && !withinDeadline(startedAt, limits)) return null;
      if (sourceNormalized.includes(points.slice(index, index + WINDOW_CODE_POINTS).join(''))) return true;
    }
  }
  return false;
}

function incomplete() {
  return { ok: false, error_code: 'source_scan_incomplete' };
}

function rawSource(pathname) {
  return { ok: false, error_code: 'raw_source_detected', paths: [pathname] };
}

function withinDeadline(startedAt, limits) {
  return Date.now() - startedAt <= limits.maxWallMs;
}

function remainingDeadlineMs(startedAt, limits) {
  return limits.maxWallMs - (Date.now() - startedAt);
}

async function listedPaths(projectRoot, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', projectRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        encoding: 'buffer',
        shell: false,
        maxBuffer: 2 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true
      }
    );
    const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    return output.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Scan tracked and untracked nonignored project text for nontrivial material
 * copied into a safe-document candidate. The scanner is read-only and fails
 * closed whenever its fixed resource budget cannot be honoured.
 * @param {{projectRoot: string, texts: Array<{path: string, value: string}>, limits?: Object}} options
 */
export async function scanSourceSimilarity({ projectRoot, texts, limits: suppliedLimits } = {}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || !Array.isArray(texts)) return incomplete();
  if (!texts.every(item => isPlainObject(item) && typeof item.path === 'string' && typeof item.value === 'string')) {
    return incomplete();
  }
  const limits = boundedLimits(suppliedLimits);
  if (!limits) return incomplete();

  const startedAt = Date.now();
  const paths = await listedPaths(projectRoot, remainingDeadlineMs(startedAt, limits));
  if (!paths || paths.length > limits.maxFiles || !withinDeadline(startedAt, limits)) return incomplete();

  let totalBytes = 0;
  let scannedFiles = 0;
  let binaryFiles = 0;
  for (const relativePath of paths) {
    if (!safeRelativePath(relativePath) || !withinDeadline(startedAt, limits)) return incomplete();
    const filePath = path.resolve(projectRoot, relativePath);
    if (!filePath.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) return incomplete();

    let stats;
    try {
      stats = await lstat(filePath);
    } catch {
      return incomplete();
    }
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    if (stats.size > limits.maxFileBytes || totalBytes + stats.size > limits.maxTotalBytes) return incomplete();
    totalBytes += stats.size;

    let bytes;
    try {
      bytes = await readFile(filePath);
    } catch {
      return incomplete();
    }
    if (!withinDeadline(startedAt, limits)) return incomplete();
    if (bytes.subarray(0, 8 * 1024).includes(0)) {
      binaryFiles += 1;
      continue;
    }

    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      binaryFiles += 1;
      continue;
    }
    if (!withinDeadline(startedAt, limits)) return incomplete();
    const sourceNormalized = normalizedLines(source).join('\n');
    if (!withinDeadline(startedAt, limits)) return incomplete();
    scannedFiles += 1;
    for (const text of texts) {
      const matched = sourceMatch(text.value, sourceNormalized, startedAt, limits);
      if (matched === null) return incomplete();
      if (matched) return rawSource(text.path);
    }
  }

  if (!withinDeadline(startedAt, limits)) return incomplete();
  return { ok: true, scanned_files: scannedFiles, binary_files: binaryFiles };
}

export const SOURCE_SIMILARITY_DEFAULT_LIMITS = DEFAULT_LIMITS;
