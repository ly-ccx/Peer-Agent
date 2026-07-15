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
 * 估算历史消息部分。单独导出是为了让 React 层只在 messages 引用变化时重算，
 * 输入框每次敲键不再扫描整段长会话。
 *
 * 压缩感知（与 toApiMessages 同口径）：发送给模型的内容并非全部 UI 消息，而是
 * - 「最后一条 compaction 之后」的活跃消息（更早的原文仅供 UI 回看，不回灌模型）；
 * - 最新 compaction 的累计连续性摘要（summary || content，对齐
 *   buildConversationContinuityContext 实际经 continuity 通道注入的文本）。
 */
export function estimateConversationHistoryTokens(messages: readonly ChatMsg[]): number {
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

  // 最新摘要已经累计 carry-forward 之前摘要；旧标记仅用于 UI 时间线，不能重复计入。
  const latestCompaction = lastCompactionIndex >= 0 ? messages[lastCompactionIndex] : undefined;
  const continuityTokens = latestCompaction?.compaction
    ? estimateTextTokens(latestCompaction.compaction.summary || latestCompaction.content)
    : 0;

  return Math.max(0, messageTokens + continuityTokens);
}

export interface ConversationTokenEstimateCache {
  readonly messageCount: number;
  readonly lastMessageId: string | null;
  readonly totalTokens: number;
  readonly lastMessageTokens: number;
}

/**
 * 增量估算历史消息。流式路由器保留所有旧 ChatMsg 引用、只替换末尾消息，
 * 因此可复用共同前缀的单条估算；压缩边界变化时回退到完整口径计算。
 */
export function estimateConversationHistoryTokensIncremental(
  messages: readonly ChatMsg[],
  previous?: ConversationTokenEstimateCache,
  tailOnly: boolean = false,
): ConversationTokenEstimateCache {
  const nextLastMessage = messages.at(-1);
  const canPatchTail = Boolean(
    tailOnly
    && previous
    && messages.length === previous.messageCount
    && nextLastMessage
    && nextLastMessage.role === 'assistant'
    && nextLastMessage.id === previous.lastMessageId
    && !nextLastMessage.compaction,
  );

  if (canPatchTail && previous && nextLastMessage) {
    const lastMessageTokens = estimateMessageTokens(nextLastMessage);
    return {
      messageCount: messages.length,
      lastMessageId: nextLastMessage.id,
      totalTokens: previous.totalTokens - previous.lastMessageTokens + lastMessageTokens,
      lastMessageTokens,
    };
  }

  return {
    messageCount: messages.length,
    lastMessageId: nextLastMessage?.id ?? null,
    totalTokens: estimateConversationHistoryTokens(messages),
    lastMessageTokens: nextLastMessage ? estimateMessageTokens(nextLastMessage) : 0,
  };
}

/** 当前草稿部分独立估算，避免草稿变化使历史消息重复扫描。 */
export function estimateDraftTokens(
  draft: string,
  draftAttachments: readonly ChatAttachment[],
): number {
  return Math.max(0, estimateTextTokens(draft) + estimateAttachmentTokens(draftAttachments));
}

/** 兼容既有调用者的组合入口。 */
export function estimateConversationTokens(messages: readonly ChatMsg[], draft: string, draftAttachments: readonly ChatAttachment[]): number {
  return estimateConversationHistoryTokens(messages) + estimateDraftTokens(draft, draftAttachments);
}
