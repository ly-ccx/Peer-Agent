import type { ChatMsg } from './types.ts';

/**
 * 回合计时锚点解析。
 *
 * 真值语义：本轮「用户消息发送时刻」。
 * - Goal Runner 每 tick 会换新 stream，stream.startedAt 不是回合起点。
 * - 会话切换 / reattach 时，应用 bucket.turnStartedAt 或最后一条用户消息时间戳恢复。
 * - 只有在没有既有锚点时，才允许用 fallback（例如当前 stream 起点）补种。
 */
export function resolveTurnStartedAt(options: {
  readonly existing?: number | null;
  readonly messages?: ReadonlyArray<Pick<ChatMsg, 'role' | 'timestamp'>> | null;
  readonly fallback?: number | null;
}): number | null {
  const existing = options.existing;
  if (typeof existing === 'number' && Number.isFinite(existing) && existing > 0) {
    return existing;
  }

  const messages = options.messages;
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (msg?.role !== 'user') continue;
      const ts = msg.timestamp;
      if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
        return ts;
      }
    }
  }

  const fallback = options.fallback;
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  return null;
}
