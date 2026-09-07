/**
 * 会话消息加载门控（纯函数）。
 *
 * 切会话时 beginLoad 会清空 messages 并置 loading。
 * 若会话桶已 ready 且仍有消息，应保留可见内容做静默刷新，避免闪「正在加载会话…」。
 * providers 异步到达不得触发整表 beginLoad（那是重复闪加载的主因）。
 */

export type ConversationLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export function shouldHardBeginConversationLoad(input: {
  readonly loadStatus: ConversationLoadStatus | string;
  readonly messageCount: number;
}): boolean {
  // 桶已 ready：不要 beginLoad 清空。选区子会话首次发送会先 adopt 空草稿桶再写消息，
  // 此时 messageCount 仍可能为 0；硬加载会把即将发出的回合冲掉。
  if (input.loadStatus === 'ready') {
    return false;
  }
  return true;
}

/**
 * provider 能力校正只有在已有会话恢复完成后才能持久化。
 * draft 没有持久化元数据，仍允许使用全局默认值立即完成校正。
 */
export function shouldPersistEffortCorrection(input: {
  readonly conversationId: string | null;
  readonly loadStatus: ConversationLoadStatus | string;
}): boolean {
  return input.conversationId === null || input.loadStatus === 'ready';
}

/** 会话主加载 effect 是否应把 providers 放进依赖：永远不应。 */
export function conversationLoadEffectShouldDependOnProviders(): boolean {
  return false;
}
