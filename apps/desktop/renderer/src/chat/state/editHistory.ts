import type { ChatMsg } from './types';

/** Return the conversation prefix retained when a historical user message is edited. */
export function historyBeforeEditedUserMessage(
  messages: readonly ChatMsg[],
  messageId: string,
): ChatMsg[] | null {
  const messageIndex = messages.findIndex((message) => message.id === messageId);
  const target = messages[messageIndex];
  if (!target || target.role !== 'user') return null;
  return messages.slice(0, messageIndex);
}

export function serializeConversationMessages(messages: readonly ChatMsg[]): Record<string, unknown>[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    segments: message.segments,
    usage: message.usage,
    durationMs: message.durationMs,
    timestamp: message.timestamp,
    _compaction: message.compaction,
    attachments: message.attachments,
    interrupted: message.interrupted,
  }));
}
