// 把会话视图模型（ChatMsg）映射为发送给模型 API 的消息序列。
// 纯函数、无副作用、不依赖 React，从 ChatSurface.tsx 下沉而来，行为保持不变。
//
// 边界与证据治理：
// - assistant 历史正文经 sanitizeAssistantHistoryTextForApi 清洗，剥离仅供本地展示的
//   「[Tool call:]/[Tool result]」痕迹，避免把展示态文本当成可执行内容回灌给模型。
// - 完整 assistant 工具调用段回放为结构化 tool_calls + role:tool pair；不完整工具段才经
//   formatHistoricalLocalRecordForApi 转成只读历史事实，避免生成孤儿 tool_result。
// - compaction 消息不进入 API 序列；最后一条 compaction 之前的原文也不进入 API 序列，
//   仅留给 UI 回看，模型连续性由独立 Context Source 的压缩摘要表达。
// 这些都属于「事实/用户上下文」的映射，不会把任何内容提升为 system 指令。

import type {
  ChatApiContentPart,
  ChatApiMessage,
  ChatApiToolCall,
  ChatAttachment,
  ChatMsg,
  ContentSegment,
} from './types';
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
export function hasApiMessageContent(content: string | ChatApiContentPart[] | null | undefined): boolean {
  if (content === null || content === undefined) return false;
  if (typeof content === 'string') return content.trim().length > 0;
  return content.some((part) => {
    if (part.type === 'image_url') return Boolean(part.image_url.url);
    return part.text.trim().length > 0;
  });
}

function hasApiMessagePayload(message: ChatApiMessage): boolean {
  return hasApiMessageContent(message.content) || Boolean(message.tool_calls?.length) || Boolean(message.tool_call_id);
}

function sanitizeToolCallId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'tool_call';
}

function stableToolCallId(message: ChatMsg, index: number, segment: ContentSegment): string | null {
  if (segment.type !== 'tool-call') return null;
  const existing = segment.toolCallId?.trim();
  if (existing) return existing;
  if (!segment.tool?.trim() || segment.result === undefined) return null;
  return `tool_call_${sanitizeToolCallId(message.id)}_${index}`;
}

function safeToolArguments(args: unknown): string {
  if (args === undefined || args === null) return '{}';
  try {
    const serialized = JSON.stringify(args);
    return serialized && serialized !== 'undefined' ? serialized : '{}';
  } catch {
    return JSON.stringify({ raw: String(args) });
  }
}

function structuredToolMessages(message: ChatMsg, index: number, segment: ContentSegment): ChatApiMessage[] | null {
  if (message.role !== 'assistant' || segment.type !== 'tool-call') return null;
  const name = segment.tool?.trim();
  if (!name || segment.result === undefined) return null;
  const id = stableToolCallId(message, index, segment);
  if (!id) return null;
  const toolCall: ChatApiToolCall = {
    id,
    type: 'function',
    function: {
      name,
      arguments: safeToolArguments(segment.args ?? {}),
    },
  };
  return [
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: id, name, content: segment.result ?? '' },
  ];
}

function textMessage(role: ChatMsg['role'], text: string): ChatApiMessage | null {
  const content = text.trim();
  return content ? { role, content } : null;
}

function getStructuredApiMessages(message: ChatMsg): ChatApiMessage[] {
  if (!message.segments?.length || message.role !== 'assistant') {
    const content = getApiMessageContent(message);
    return hasApiMessageContent(content) ? [{ role: message.role, content }] : [];
  }

  const apiMessages: ChatApiMessage[] = [];
  const pendingText: string[] = [];
  const flushText = () => {
    const item = textMessage(message.role, pendingText.filter(Boolean).join('\n\n'));
    pendingText.length = 0;
    if (item) apiMessages.push(item);
  };

  message.segments.forEach((segment, index) => {
    if (segment.type === 'thinking') return;
    if (segment.type === 'text') {
      const content = sanitizeAssistantHistoryTextForApi(segment.content || '');
      if (content.trim()) pendingText.push(content);
      return;
    }

    const toolMessages = structuredToolMessages(message, index, segment);
    if (toolMessages) {
      flushText();
      apiMessages.push(...toolMessages);
      return;
    }

    const historicalRecord = formatHistoricalLocalRecordForApi(segment);
    if (historicalRecord.trim()) pendingText.push(historicalRecord);
  });

  flushText();
  return apiMessages.filter(hasApiMessagePayload);
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
    for (const apiMessage of getStructuredApiMessages(message)) {
      if (apiMessage.role === 'assistant' && !hasApiMessagePayload(apiMessage)) continue;
      apiMessages.push(apiMessage);
    }
  }
  return apiMessages;
}
