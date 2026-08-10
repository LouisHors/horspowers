import { McpStdioClient } from './mcp-stdio-client.mjs';
import { URL } from 'node:url';

const READ_ONLY_TOOLS = new Set(['query', 'get', 'multi_get', 'status']);
const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function failure(errorCode) {
  return { ok: false, error_code: errorCode };
}

function isCollectionUri(file, collection) {
  if (typeof file !== 'string' || !COLLECTION_PATTERN.test(collection) || !file.startsWith(`qmd://${collection}/`)) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(file);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'qmd:' || parsed.hostname !== collection || parsed.username || parsed.password ||
      parsed.port || parsed.search || parsed.hash) {
    return false;
  }
  const relativePath = file.slice(`qmd://${collection}/`.length);
  if (!relativePath || /[\s?#\\\0]/u.test(relativePath)) return false;
  return relativePath.split('/').every((segment) => {
    if (!segment || segment === '.' || segment === '..') return false;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded !== '.' && decoded !== '..' && !decoded.includes('/') && !decoded.includes('\\') && !decoded.includes('\0');
    } catch {
      return false;
    }
  });
}

function toolNames(result) {
  if (!Array.isArray(result?.tools) || Object.hasOwn(result, 'nextCursor')) return null;
  const names = [];
  const seen = new Set();
  for (const tool of result.tools) {
    if (!tool || typeof tool.name !== 'string' || !READ_ONLY_TOOLS.has(tool.name) || seen.has(tool.name)) return null;
    seen.add(tool.name);
    names.push(tool.name);
  }
  return names;
}

function boundedSearchText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4_000 && !/[\0\r\n]/u.test(value);
}

/**
 * A qmd wrapper with no generic tool-call API. Configuration reads can only
 * issue exact `get` calls; topic search has its own constrained `query` API.
 */
export class QmdMcpClient {
  #collection;
  #transport;
  #spawnImpl;

  constructor({ collection, transport }, { spawnImpl } = {}) {
    this.#collection = collection;
    this.#transport = transport;
    this.#spawnImpl = spawnImpl;
  }

  async #withReadOnlyTools(requiredTool, operation) {
    if (!COLLECTION_PATTERN.test(this.#collection)) return failure('qmd_invalid_collection');
    const client = new McpStdioClient({
      sshAlias: this.#transport?.ssh_alias,
      timeoutMs: this.#transport?.timeout_ms,
      maxResponseBytes: this.#transport?.max_response_bytes
    }, { spawnImpl: this.#spawnImpl });

    return client.run(async (session) => {
      const listed = await session.request('tools/list', {});
      if (!listed.ok) return listed;
      const names = toolNames(listed.result);
      if (!names) return failure('qmd_readonly_tools_invalid');
      if (!names.includes(requiredTool)) {
        return failure(requiredTool === 'get' ? 'qmd_get_tool_unavailable' : 'qmd_query_tool_unavailable');
      }
      return operation(session);
    });
  }

  /**
   * Read an exact file through qmd's `get` tool. It never calls `query`.
   */
  async getExact(file) {
    if (!isCollectionUri(file, this.#collection)) return failure('qmd_invalid_uri');
    return this.#withReadOnlyTools('get', (session) => session.request('tools/call', {
      name: 'get',
      arguments: {
        file,
        fromLine: 1,
        maxLines: 4000,
        lineNumbers: false
      }
    }));
  }

  /**
   * Search is intentionally separate from configuration lookup and always
   * pins qmd to this configured collection with reranking disabled.
   */
  async search({ query, intent } = {}) {
    if (!boundedSearchText(query) || !boundedSearchText(intent)) return failure('qmd_invalid_search');
    return this.#withReadOnlyTools('query', (session) => session.request('tools/call', {
      name: 'query',
      arguments: {
        query,
        collections: [this.#collection],
        intent,
        rerank: false
      }
    }));
  }
}
