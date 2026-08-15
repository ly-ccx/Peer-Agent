// 把其他会话引用成可发送的文本附件。
// 仅做表达层装配：读取会话消息 → 压成文本 → 作为 ChatAttachment(kind=text)
// 进入既有附件发送链路（buildAttachmentText / contextAttachments），
// 不另开执行路径，不把会话内容提升为 system 指令。

import type { ChatAttachment, ChatMsg } from './types';

export type SessionReferenceHit = {
  readonly id: string;
  readonly title?: string;
  readonly workspacePath?: string | null;
  readonly updatedAt?: string;
  readonly createdAt?: string;
};

/** 检测光标前是否正在输入 @ 会话引用（token 内不含空白）。 */
export function detectAtQuery(
  text: string,
  caret = text.length,
): { start: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = before.match(/(^|[\s\n])@([^\s@]*)$/);
  if (!match || match.index == null) return null;
  const atIndex = match.index + match[1].length;
  return { start: atIndex, query: match[2] ?? '' };
}

/** 用选中的会话标题替换当前 @query，并在末尾补一个空格便于继续输入。 */
export function insertSessionMention(
  text: string,
  start: number,
  query: string,
  title: string,
): string {
  const safeTitle = (title || 'untitled').replace(/\s+/g, ' ').trim() || 'untitled';
  const mention = `@${safeTitle}`;
  const end = start + 1 + query.length;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const needsSpace = after.length === 0 || !/^\s/.test(after);
  return `${before}${mention}${needsSpace ? ' ' : ''}${after}`;
}

function roleLabel(role: ChatMsg['role']): string {
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

function sanitizeMessageContent(message: ChatMsg): string {
  const raw = (message.content || '').trim();
  if (!raw) return '';
  // 压缩摘要本身是 continuity 事实，引用时保留正文即可。
  if (message.compaction) return raw;
  // 本地展示态工具痕迹不应原样回灌；只保留可读正文。
  return raw
    .replace(/\[Tool call:[^\]]*\]/g, '')
    .replace(/\[Tool result[^\]]*\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 将会话消息压成文本摘要。
 * - 跳过空消息
 * - 限制条数，避免把超长历史整包塞进一轮
 */
export function formatConversationTranscript(
  messages: readonly ChatMsg[],
  options?: { readonly maxMessages?: number; readonly maxChars?: number },
): string {
  const maxMessages = options?.maxMessages ?? 40;
  const maxChars = options?.maxChars ?? 24_000;
  const usable = messages
    .map((message) => {
      const content = sanitizeMessageContent(message);
      if (!content) return null;
      return `${roleLabel(message.role)}: ${content}`;
    })
    .filter((line): line is string => Boolean(line));

  if (usable.length === 0) return '(empty conversation)';

  const sliced = usable.length > maxMessages
    ? usable.slice(usable.length - maxMessages)
    : usable;
  let text = sliced.join('\n\n');
  if (usable.length > maxMessages) {
    text = `…(${usable.length - maxMessages} earlier messages omitted)\n\n${text}`;
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n\n…(truncated)`;
  }
  return text;
}

export function buildSessionReferenceAttachment(params: {
  readonly conversationId: string;
  readonly title?: string;
  readonly messages: readonly ChatMsg[];
}): ChatAttachment {
  const title = (params.title || 'untitled').replace(/\s+/g, ' ').trim() || 'untitled';
  const text = [
    `Referenced conversation: ${title}`,
    `Conversation ID: ${params.conversationId}`,
    'Transcript:',
    formatConversationTranscript(params.messages),
  ].join('\n');
  const bytes = new TextEncoder().encode(text).length;
  return {
    id: `session-ref-${params.conversationId}-${Date.now().toString(36)}`,
    name: `session:${title}.txt`,
    mimeType: 'text/plain',
    size: bytes,
    kind: 'text',
    text,
    sourceKind: 'session_reference',
  };
}
