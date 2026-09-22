import type { ChatMsg } from '../chat/state/types.ts';

export type MonitorSource =
  | { kind: 'file'; id: string; label: string; path: string }
  | { kind: 'attachment'; id: string; label: string; messageId: string; attachmentId: string }
  | { kind: 'tool'; id: string; label: string; messageId: string; toolCallId: string }
  | { kind: 'web'; id: string; label: string; url: string; tabId: string };

/** Inputs must belong to the selected conversation. Never infer usage from prose or inventory. */
export function projectMonitorSources(messages: readonly ChatMsg[], tabs: readonly {
  id: string; url: string; title?: string;
}[]): readonly MonitorSource[] {
  const sources = new Map<string, MonitorSource>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      const key = `attachment:${attachment.filePath || attachment.id}`;
      if (sources.has(key)) continue;
      sources.set(key, attachment.filePath
        ? { kind: 'file', id: key, label: attachment.name, path: attachment.filePath }
        : { kind: 'attachment', id: key, label: attachment.name, messageId: message.id, attachmentId: attachment.id });
    }
    if (message.role !== 'assistant') continue;
    for (const segment of message.segments ?? []) {
      if (segment.type !== 'tool-call' || segment.synthetic || !segment.toolCallId) continue;
      const tool = segment.tool ?? '';
      if (!(tool.startsWith('skill__') && tool.length > 7) && !(tool.startsWith('mcp__') && tool.length > 5)) continue;
      const key = `tool:${tool}`;
      // Latest actual call is the detail target for a reused tool.
      sources.set(key, { kind: 'tool', id: key,
        label: segment.displayName?.trim() || (tool.startsWith('skill__') ? tool.slice(7) : tool.slice(5).replaceAll('__', ': ')),
        messageId: message.id, toolCallId: segment.toolCallId });
    }
  }
  for (const tab of tabs) {
    try {
      const url = new URL(tab.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      const key = `web:${url.href}`;
      if (!sources.has(key)) sources.set(key, { kind: 'web', id: key, label: tab.title?.trim() || url.hostname,
        url: url.href, tabId: tab.id });
    } catch { /* Empty/invalid tab URLs are not sources. */ }
  }
  return [...sources.values()];
}
