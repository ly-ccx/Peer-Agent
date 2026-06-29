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

/** 估算整段会话（历史消息 + 草稿 + 草稿附件）的上下文 token 总量。 */
export function estimateConversationTokens(messages: readonly ChatMsg[], draft: string, draftAttachments: readonly ChatAttachment[]): number {
  const messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return Math.max(0, messageTokens + estimateTextTokens(draft) + estimateAttachmentTokens(draftAttachments));
}
