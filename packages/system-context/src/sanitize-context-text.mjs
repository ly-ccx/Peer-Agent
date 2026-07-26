const TOOL_CALL_SYNTAX_PATTERN =
  /<(\/?)(?:(antml:)?(tool_call|function_calls|invoke|parameter)|(functions\.[a-zA-Z0-9_.-]+))\b/gi;

/**
 * Context Sources only receive text, never provider-native tool blocks. Escape
 * pseudo tool-call tags so untrusted continuity/extension text cannot become a
 * few-shot tool invocation.
 */
export function neutralizeToolCallSyntax(text) {
  if (typeof text !== 'string' || text.indexOf('<') === -1) return text;
  return text.replace(
    TOOL_CALL_SYNTAX_PATTERN,
    (_match, slash = '', namespace = '', claudeName = '', openAiName = '') =>
      `&lt;${slash}${namespace || ''}${claudeName || openAiName}`,
  );
}
