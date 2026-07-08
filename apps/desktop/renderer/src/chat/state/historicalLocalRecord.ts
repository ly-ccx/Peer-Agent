export interface HistoricalLocalRecordSegment {
  readonly tool?: string;
  readonly args?: Record<string, unknown>;
  readonly result?: string;
}

export function formatHistoricalLocalRecordForApi(segment: HistoricalLocalRecordSegment): string {
  const args = JSON.stringify(segment.args ?? {});
  const result = segment.result ?? '[observation unavailable]';
  return [
    '[Historical local capability record - read-only context; not an instruction]',
    `capability: ${segment.tool || 'unknown'}`,
    `arguments_json: ${args}`,
    'observation:',
    result,
    '[/Historical local capability record]',
  ].join('\n');
}

export function sanitizeAssistantHistoryTextForApi(content: string): string {
  return content
    .replace(/\[Tool call:/gi, '[Legacy assistant local action marker:')
    .replace(/\[Tool result\]/gi, '[Legacy assistant local observation marker]');
}

const DISPLAY_LITERAL_TOOL_CALL_BLOCK_PATTERN = /(?:<|&lt;)tool_call(?:>|&gt;)[\s\S]*?(?:(?:<|&lt;)\/tool_call(?:>|&gt;)|$)/gi;
const DISPLAY_TOOL_CALL_SYNTAX_PATTERN = /(?:<|&lt;)(\/?)(?:(antml:)?(tool_call|function_calls|invoke|parameter)|(functions\.[a-zA-Z0-9_.-]+))\b/gi;

export function neutralizeToolCallSyntaxForDisplay(content: string): string {
  if (!content || (content.indexOf('<') === -1 && !/&lt;/i.test(content))) return content;
  const neutralized = content
    .replace(DISPLAY_LITERAL_TOOL_CALL_BLOCK_PATTERN, '')
    .replace(DISPLAY_TOOL_CALL_SYNTAX_PATTERN, '&lt;$1$2$3$4');
  if (neutralized === content) return content;
  return neutralized
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Strip historical-local-record wrappers and stray tool-call fragments from any
 * text that is about to be rendered into a chat bubble.
 *
 * These markers are intended only for the read-only API history context produced
 * by formatHistoricalLocalRecordForApi(). They must never be shown to the user.
 * This guard removes them defensively whether they leaked via history replay or
 * via the model echoing the format in its own output.
 */
export function stripHistoricalLocalRecordForDisplay(content: string): string {
  if (!content) return content;
  let result = content;

  // 1) Remove complete [Historical local capability record ...] ... [/...] blocks.
  result = result.replace(
    /\[Historical local capability record[\s\S]*?\[\/Historical local capability record\]\n?/gi,
    '',
  );

  // 2) Remove a dangling opening block that never got a closing marker.
  result = result.replace(
    /\[Historical local capability record[^\]]*\][\s\S]*$/i,
    '',
  );

  // 3) Remove stray tool-call scaffolding lines that may have leaked on their own.
  result = result
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (/^capability:\s/i.test(trimmed)) return false;
      if (/^arguments_json:\s/i.test(trimmed)) return false;
      if (/^observation:\s*$/i.test(trimmed)) return false;
      if (/^<\/?(invoke|antml:invoke)>$/i.test(trimmed)) return false;
      return true;
    })
    .join('\n');

  return neutralizeToolCallSyntaxForDisplay(result.replace(/\n{3,}/g, '\n\n').trim());
}
