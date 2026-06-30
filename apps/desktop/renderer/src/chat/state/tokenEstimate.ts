// 会话 token 估算：基于字符数的启发式估算（约 4 字符 ≈ 1 token）。
// 纯函数、无副作用、不依赖 React，从 ChatSurface.tsx 下沉而来，行为保持不变。
// 仅用于展示「当前上下文估算用量」，非计费真相；真实用量以 provider 返回的 usage 为准。

import type { ChatAttachment, ChatMsg } from './types';

// 英文约 4 字符/token；中日韩等 CJK 字符分词密度更高，约 1.7 字符/token。
// 与主进程 context-compactor.mjs 的 charsPerToken / cjkCharsPerToken 保持一致，
// 避免渲染端进度条把大量中文按 /4 系统性低估约 2 倍。
const CHARS_PER_TOKEN = 4;
const CJK_CHARS_PER_TOKEN = 1.7;
const CJK_REGEX =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g;

/** 估算任意值序列化后的 token 数（CJK 感知：中文按更高权重，其余约 4 字符 ≈ 1 token）。 */
export function estimateTextTokens(value: unknown): number {
  const str = String(value ?? '');
  if (!str) return 0;
  const cjkCount = (str.match(CJK_REGEX) || []).length;
  const otherCount = str.length - cjkCount;
  return Math.ceil(cjkCount / CJK_CHARS_PER_TOKEN + otherCount / CHARS_PER_TOKEN);
}

/** 估算单条消息的 token：基础开销 + 正文 + 附件 + 各分段（工具调用/正文）。 */
export function estimateMessageTokens(message: ChatMsg): number {
  let tokens = 10;
  tokens += estimateTextTokens(message.content);
  if (message.attachments?.length) {
    for (const attachment of message.attachments) {
      tokens += estimateTextTokens(attachment.name);
      tokens += estimateTextTokens(attachment.text);
      if (attachment.kind === 'image') tokens += 800;
    }
  }
  if (message.segments?.length) {
    for (const segment of message.segments) {
      if (segment.type === 'tool-call') {
        tokens += estimateTextTokens(segment.tool);
        tokens += estimateTextTokens(JSON.stringify(segment.args ?? {}));
        tokens += estimateTextTokens(segment.result);
      } else if (segment.type === 'text') {
        tokens += estimateTextTokens(segment.content);
      }
    }
  }
  return tokens;
}

/** 估算一组附件的 token（文本按字符数，图片按固定近似值）。 */
export function estimateAttachmentTokens(attachments: readonly ChatAttachment[]): number {
  return attachments.reduce((sum, attachment) => {
    return sum + estimateTextTokens(attachment.name) + estimateTextTokens(attachment.text) + (attachment.kind === 'image' ? 800 : 0);
  }, 0);
}

/**
 * 估算整段会话（历史消息 + 草稿 + 草稿附件）的上下文 token 总量。
 *
 * 压缩感知（与 toApiMessages 同口径）：发送给模型的内容并非全部 UI 消息，而是
 * - 「最后一条 compaction 之后」的活跃消息（更早的原文仅供 UI 回看，不回灌模型）；
 * - 各 compaction 的连续性摘要（summary || content，对齐 buildConversationContinuityContext
 *   实际经 continuity 通道注入的文本）。
 * 因此估算只统计这部分，使压缩完成瞬间显示值随之回落，避免被压缩前原文长期顶高。
 * 无 compaction 时退化为「全部消息求和」的原行为，保证向后兼容。
 */
export function estimateConversationTokens(messages: readonly ChatMsg[], draft: string, draftAttachments: readonly ChatAttachment[]): number {
  const lastCompactionIndex = messages.reduce(
    (latest, message, index) => (message.compaction ? index : latest),
    -1,
  );
  const activeMessages = lastCompactionIndex >= 0 ? messages.slice(lastCompactionIndex + 1) : messages;

  let messageTokens = 0;
  for (const message of activeMessages) {
    if (message.compaction) continue;
    messageTokens += estimateMessageTokens(message);
  }

  // 计入所有 compaction 的连续性摘要（无论是否在活跃区间内，摘要都会被注入连续性上下文）。
  let continuityTokens = 0;
  for (const message of messages) {
    if (!message.compaction) continue;
    continuityTokens += estimateTextTokens(message.compaction.summary || message.content);
  }

  return Math.max(0, messageTokens + continuityTokens + estimateTextTokens(draft) + estimateAttachmentTokens(draftAttachments));
}
