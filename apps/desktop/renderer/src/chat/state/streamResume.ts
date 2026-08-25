import type { ChatMsg } from './types';

function isEmptyAssistantPlaceholder(message: Pick<ChatMsg, 'role' | 'content' | 'segments'>): boolean {
  return (
    message.role === 'assistant' &&
    message.content.trim() === '' &&
    (!Array.isArray(message.segments) || message.segments.length === 0)
  );
}

export type StreamResumeTarget =
  | { readonly kind: 'regenerate'; readonly assistantIndex: number }
  | { readonly kind: 'retry-user'; readonly userIndex: number };

const RETRYABLE_STREAM_ERROR_PATTERNS = [
  /fetch failed/i,
  /network/i,
  /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i,
  /UND_ERR_|HeadersTimeoutError|ConnectTimeoutError|SocketError/i,
  /ERR_NETWORK/i,
  /net::/i,
  /empty_visible_model_response/i,
  /repetition_detected/i,
  /aborted/i,
  /timeout/i,
  /socket hang up/i,
  /terminated/i,
];

/** Network / transport / truncated-turn failures that can continue the current session. */
export function isRetryableStreamError(error: string | null | undefined): boolean {
  const text = String(error || '').trim();
  if (!text) return false;
  return RETRYABLE_STREAM_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Pick the current-session resume path:
 * - last real assistant turn → regenerate that reply (keeps prior user + history)
 * - last user with no assistant (empty placeholder already stripped) → resend that user
 */
export function resolveStreamResumeTarget(messages: readonly ChatMsg[]): StreamResumeTarget | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (isEmptyAssistantPlaceholder(message)) continue;
    if (message.role === 'assistant') {
      return { kind: 'regenerate', assistantIndex: index };
    }
    if (message.role === 'user') {
      return { kind: 'retry-user', userIndex: index };
    }
  }
  return null;
}

const STREAM_ERROR_COPY: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly zh: string;
  readonly en: string;
}> = [
  {
    pattern: /repetition_detected/i,
    zh: '检测到重复输出，已自动停止本轮回复。',
    en: 'Repetitive output detected; this reply was stopped automatically.',
  },
  {
    pattern: /ERR_NETWORK_CHANGED/i,
    zh: '网络已切换，回复中断。',
    en: 'Network changed; the reply was interrupted.',
  },
  {
    pattern: /ERR_INTERNET_DISCONNECTED/i,
    zh: '网络已断开，回复中断。',
    en: 'Internet disconnected; the reply was interrupted.',
  },
  {
    pattern: /ERR_CONNECTION_RESET|ECONNRESET|socket hang up/i,
    zh: '连接被重置，回复中断。',
    en: 'The connection was reset; the reply was interrupted.',
  },
  {
    pattern: /ERR_CONNECTION_REFUSED|ECONNREFUSED/i,
    zh: '连接被拒绝，回复中断。',
    en: 'The connection was refused; the reply was interrupted.',
  },
  {
    pattern: /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i,
    zh: '无法解析服务器地址，回复中断。',
    en: 'Could not resolve the server; the reply was interrupted.',
  },
  {
    pattern: /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT|HeadersTimeoutError|ConnectTimeoutError/i,
    zh: '连接超时，回复中断。',
    en: 'The connection timed out; the reply was interrupted.',
  },
  {
    pattern: /net::ERR_|ERR_NETWORK|fetch failed/i,
    zh: '网络中断，回复未完成。',
    en: 'Network interrupted; the reply was not finished.',
  },
];

export function formatStreamErrorLabel(error: string, isZh: boolean): string {
  const text = String(error || '').trim();
  if (!text) return text;
  for (const entry of STREAM_ERROR_COPY) {
    if (entry.pattern.test(text)) return isZh ? entry.zh : entry.en;
  }
  return error;
}

export function canShowStreamResume(
  error: string | null | undefined,
  messages: readonly ChatMsg[],
  isStreaming: boolean,
): boolean {
  if (isStreaming || !String(error || '').trim()) return false;
  return resolveStreamResumeTarget(messages) !== null;
}
