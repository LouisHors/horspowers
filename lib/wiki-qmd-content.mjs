const QMD_CONTEXT_HEADER = /^<!-- Context:[^\r\n]*-->\r?\n\r?\n/u;
const QMD_LINE_NUMBER = /^\d+: ?/u;

/**
 * qmd 2.5.3 wraps MCP resources with a context header and line numbers.
 * Convert that presentation back to the indexed Markdown bytes.
 * @param {string} value
 * @returns {string}
 */
export function markdownFromQmdResource(value) {
  const withoutContext = value.replace(QMD_CONTEXT_HEADER, '');
  return withoutContext.replace(/(^|\r?\n)\d+: ?/gu, '$1');
}
