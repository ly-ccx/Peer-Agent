import type { ChatAttachment } from './types';

/** Collect file-backed clipboard items (including screenshots) for Quick Chat intake. */
export function getClipboardFiles(items: Iterable<Pick<DataTransferItem, 'kind' | 'getAsFile'>>): File[] {
  return Array.from(items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/** Quick Chat may submit either text, attachments, or both. */
export function hasQuickChatContent(text: string, attachments: readonly ChatAttachment[]): boolean {
  return Boolean(text.trim()) || attachments.length > 0;
}
