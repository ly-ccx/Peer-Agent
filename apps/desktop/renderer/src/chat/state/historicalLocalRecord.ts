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
