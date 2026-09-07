import type { SelectionReference } from '@peer-agent/protocol';
import type { ChatAttachment } from './types.ts';

/** Preserve all existing attachments and canonical source identity; never change input text. */
export function appendSelectionQuote(previous: ChatAttachment[], reference: SelectionReference): ChatAttachment[] {
  if (previous.some((item) => item.id === reference.id)) return previous;
  const text = `Quoted user material (${reference.sourceConversationId}/${reference.sourceMessageId}, ${reference.start}:${reference.end}):\n${reference.exactText}`;
  return [...previous, {
    id: reference.id, name: '引用选区.txt', kind: 'text', mimeType: 'text/plain',
    size: new TextEncoder().encode(text).length, text, sourceKind: 'session_reference',
    selectionReference: { ...reference },
  }];
}
