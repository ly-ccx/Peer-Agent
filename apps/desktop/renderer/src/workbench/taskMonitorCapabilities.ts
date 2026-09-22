import type { ChatMsg } from '../chat/state/types.ts';

/** Read structured calls only; installed tools and assistant prose are not usage. */
export function projectUsedMonitorCapabilities(messages: readonly ChatMsg[]): readonly string[] {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const segment of message.segments ?? []) {
      if (segment.type !== 'tool-call' || segment.synthetic || !segment.toolCallId) continue;
      const tool = segment.tool ?? '';
      if (tool.startsWith('skill__') && tool.length > 7) {
        names.set(tool, segment.displayName?.trim() || tool.slice(7));
      } else if (tool.startsWith('mcp__') && tool.length > 5) {
        names.set(tool, segment.displayName?.trim() || tool.slice(5).replaceAll('__', ': '));
      }
    }
  }
  return [...names.values()];
}
