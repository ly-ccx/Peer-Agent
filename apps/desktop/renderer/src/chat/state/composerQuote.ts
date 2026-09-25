import type { SelectionReference } from '@peer-agent/protocol';
import type { ChatAttachment } from './types.ts';

/** 选区引用不是文件附件。用 selectionReference 区分，避免和 @ 会话引用混在一起。 */
export function isSelectionQuoteAttachment(attachment: ChatAttachment): boolean {
  return attachment.selectionReference != null;
}

export function splitSelectionQuotes(attachments: readonly ChatAttachment[]): {
  quotes: ChatAttachment[];
  files: ChatAttachment[];
} {
  const quotes: ChatAttachment[] = [];
  const files: ChatAttachment[] = [];
  for (const attachment of attachments) {
    if (isSelectionQuoteAttachment(attachment)) quotes.push(attachment);
    else files.push(attachment);
  }
  return { quotes, files };
}

/** 输入框里只展示截断原文，完整原文仍留在 attachment.text 里发给模型。 */
export function quotePreviewText(exactText: string, max = 72): string {
  const flat = exactText.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max)}...`;
}

export function formatSelectionQuoteBody(reference: SelectionReference): string {
  return `Quoted user material (${reference.sourceConversationId}/${reference.sourceMessageId}, ${reference.start}:${reference.end}):\n${reference.exactText}`;
}

/** 追加选区引用，不改已有附件，也不改输入框草稿文字。 */
export function appendSelectionQuote(previous: ChatAttachment[], reference: SelectionReference): ChatAttachment[] {
  if (previous.some((item) => item.id === reference.id)) return previous;
  const text = formatSelectionQuoteBody(reference);
  return [...previous, {
    id: reference.id,
    name: reference.id,
    kind: 'text',
    mimeType: 'text/plain',
    size: new TextEncoder().encode(text).length,
    text,
    sourceKind: 'session_reference',
    selectionReference: { ...reference },
  }];
}
