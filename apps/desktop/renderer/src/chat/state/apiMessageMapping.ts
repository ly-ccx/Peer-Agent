// 把会话视图模型（ChatMsg）映射为发送给模型 API 的消息序列。
// 纯函数、无副作用、不依赖 React，从 ChatSurface.tsx 下沉而来，行为保持不变。
//
// 边界与证据治理：
// - assistant 历史正文经 sanitizeAssistantHistoryTextForApi 清洗，剥离仅供本地展示的
//   「[Tool call:]/[Tool result]」痕迹，避免把展示态文本当成可执行内容回灌给模型。
// - 结构化工具调用段经 formatHistoricalLocalRecordForApi 转成只读的历史事实记录文本。
// - compaction 消息不进入 API 序列；最后一条 compaction 之前的原文也不进入 API 序列，
//   仅留给 UI 回看，模型连续性由独立 Context Source 的压缩摘要表达。
// 这些都属于「事实/用户上下文」的映射，不会把任何内容提升为 system 指令。

import type { ChatApiContentPart, ChatApiMessage, ChatAttachment, ChatMsg } from './types';
import { formatBytes } from './format.ts';
import { formatHistoricalLocalRecordForApi, sanitizeAssistantHistoryTextForApi } from './historicalLocalRecord.ts';

/** 把一条消息的分段/正文折叠成发送给 API 的纯文本（thinking 段丢弃，工具段转历史记录）。 */
export function getApiContent(message: ChatMsg): string {
  if (!message.segments?.length) {
    return message.role === 'assistant'
      ? sanitizeAssistantHistoryTextForApi(message.content)
      : message.content;
  }
  return message.segments
    .map((segment) => {
      if (segment.type === 'thinking') return '';
      if (segment.type !== 'text') return formatHistoricalLocalRecordForApi(segment);
      const content = segment.content || '';
      return message.role === 'assistant' ? sanitizeAssistantHistoryTextForApi(content) : content;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** 把文本类/不支持类附件渲染成附加到正文后的文本块（图片不在此处，走多模态分片）。 */
export function buildAttachmentText(attachments: readonly ChatAttachment[]): string {
  const blocks: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'text') {
      blocks.push([
        `Attached file: ${attachment.name}`,
        `MIME: ${attachment.mimeType || 'text/plain'}`,
        `Size: ${formatBytes(attachment.size)}`,
        'Content:',
        '```',
        attachment.text || '',
        '```',
      ].join('\n'));
    } else if (attachment.kind === 'unsupported') {
      blocks.push([
        `Attached file: ${attachment.name}`,
        `MIME: ${attachment.mimeType || 'application/octet-stream'}`,
        `Size: ${formatBytes(attachment.size)}`,
        'Content is not included because this file type is not supported yet.',
      ].join('\n'));
    }
  }
  return blocks.join('\n\n');
}

/** 把一条消息映射为 API content：无附件时为纯文本，有附件时为多模态分片数组。 */
export function getApiMessageContent(message: ChatMsg): string | ChatApiContentPart[] {
  const text = getApiContent(message);
  const attachments = message.attachments ?? [];
  if (!attachments.length) return text;

  const parts: ChatApiContentPart[] = [];
  const attachmentText = buildAttachmentText(attachments);
  const combinedText = [text, attachmentText].filter((value) => value.trim()).join('\n\n');
  if (combinedText) parts.push({ type: 'text', text: combinedText });

  for (const attachment of attachments) {
    if (attachment.kind === 'image' && attachment.dataUrl) {
      parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
    }
  }

  return parts.length ? parts : text;
}

/** 判定一条 API content 是否包含有效内容（文本非空或存在图片 URL）。 */
export function hasApiMessageContent(content: string | ChatApiContentPart[]): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  return content.some((part) => {
    if (part.type === 'image_url') return Boolean(part.image_url.url);
    return part.text.trim().length > 0;
  });
}

/** 把会话映射为 API 消息序列：跳过最后一条 compaction 之前的 UI 原文、compaction 消息与空 assistant 消息。 */
export function toApiMessages(messages: readonly ChatMsg[]): ChatApiMessage[] {
  const lastCompactionIndex = messages.reduce(
    (latest, message, index) => (message.compaction ? index : latest),
    -1,
  );
  const activeMessages = lastCompactionIndex >= 0 ? messages.slice(lastCompactionIndex + 1) : messages;

  const apiMessages: ChatApiMessage[] = [];
  for (const message of activeMessages) {
    if (message.compaction) continue;
    const content = getApiMessageContent(message);
    if (message.role === 'assistant' && !hasApiMessageContent(content)) continue;
    apiMessages.push({ role: message.role, content });
  }
  return apiMessages;
}
