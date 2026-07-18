import { randomUUID } from 'node:crypto';

/**
 * Goal Runner 执行回合的会话消息落盘辅助。
 *
 * 背景：sendMessage 只有在明确传入 assistantMessageId 时才会把 stream
 * content/segments 回写 conversation-store。Runner 不能像用户发送那样依赖
 * renderer 先占位，必须在主进程创建 assistant 占位并绑定到 stream。
 */

/**
 * 创建一条空的 assistant 占位消息，供 runGoalTurn 在 sendMessage 前落盘。
 * @param {{ createId?: () => string, now?: number }} [options]
 * @returns {{ id: string, message: { id: string, role: 'assistant', content: string, segments: [], timestamp: number } }}
 */
export function createGoalRunnerAssistantPlaceholder({
  createId = () => randomUUID(),
  now = Date.now(),
} = {}) {
  const id = typeof createId === 'function' ? String(createId() || '') : '';
  const safeId = id || randomUUID();
  const timestamp = Number.isFinite(now) ? now : Date.now();
  return {
    id: safeId,
    message: {
      id: safeId,
      role: 'assistant',
      content: '',
      segments: [],
      timestamp,
    },
  };
}

/**
 * 组装 goalRunner:streamStarted 广播载荷，必须带上 assistantMessageId
 * 供渲染端绑定同一条消息，避免本地再造一个不同 id。
 */
export function buildGoalRunnerStreamStartedPayload({
  planId,
  conversationId = null,
  streamId,
  turnNumber,
  assistantMessageId,
  startedAt = Date.now(),
} = {}) {
  return {
    type: 'goalRunner:streamStarted',
    planId: planId ?? null,
    conversationId: conversationId ?? null,
    changeKind: 'runner-state',
    streamId: streamId ?? null,
    turnNumber: turnNumber ?? null,
    assistantMessageId: assistantMessageId ?? null,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
  };
}
