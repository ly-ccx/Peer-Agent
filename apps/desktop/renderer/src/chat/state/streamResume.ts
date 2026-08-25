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

export function formatStreamErrorLabel(error: string, isZh: boolean): string {
  if (error === 'repetition_detected') {
    return isZh
      ? '检测到重复输出，已自动停止本轮回复。'
      : 'Repetitive output detected; this reply was stopped automatically.';
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
