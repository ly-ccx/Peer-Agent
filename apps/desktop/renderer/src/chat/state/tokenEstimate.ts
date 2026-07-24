// Renderer token estimation is deliberately limited to the unsubmitted composer draft.
// Conversation history and compaction pressure are Runtime Projection facts supplied by the host.

import type { ChatAttachment } from './types';

const CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.7;
const CJK_REGEX =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g;

/** Estimate unsubmitted draft text only; this value is never a Runtime context fact. */
export function estimateTextTokens(value: unknown): number {
  const str = String(value ?? '');
  if (!str) return 0;
  const cjkCount = (str.match(CJK_REGEX) || []).length;
  const otherCount = str.length - cjkCount;
  return Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN + otherCount / CHARS_PER_TOKEN);
}

/**
 * 流式 delta 的浮点增量估算（不取整）：逐 delta 累加时若每次 ceil，
 * 小分片会系统性高估（每片 ≥1 token）；累加浮点值、展示时再取整。
 * 仅用于 stream_preview 叠加，不是 Runtime 事实。
 */
export function estimateStreamDeltaTokens(value: unknown): number {
  const str = String(value ?? '');
  if (!str) return 0;
  const cjkCount = (str.match(CJK_REGEX) || []).length;
  const otherCount = str.length - cjkCount;
  return cjkCount / CJK_CHARS_PER_TOKEN + otherCount / CHARS_PER_TOKEN;
}

/** Estimate unsubmitted draft attachments only. */
export function estimateAttachmentTokens(attachments: readonly ChatAttachment[]): number {
  return attachments.reduce((sum, attachment) => {
    return sum
      + estimateTextTokens(attachment.name)
      + estimateTextTokens(attachment.text)
      + (attachment.kind === 'image' ? 800 : 0);
  }, 0);
}

/** UI-only preview added to the authoritative Runtime projection while editing. */
export function estimateDraftTokens(
  draft: string,
  draftAttachments: readonly ChatAttachment[],
): number {
  return estimateTextTokens(draft) + estimateAttachmentTokens(draftAttachments);
}
