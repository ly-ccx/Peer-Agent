/**
 * 会话主区空态/加载门控（纯函数，便于单测）。
 *
 * 切会话时 beginLoad 会先清空 messages 并把 loadStatus 置为 loading。
 * 若 UI 只看 messages.length === 0，会在加载完成前误显空白首页。
 * 空首页仅应在 loadStatus === 'ready' 且无消息时出现。
 */

export type ConversationLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export function shouldShowConversationEmptyHome(input: {
  readonly loadStatus: ConversationLoadStatus | string;
  readonly messageCount: number;
}): boolean {
  return input.loadStatus === 'ready' && input.messageCount === 0;
}

/** 会话消息尚未 ready 且当前没有可展示消息时，显示中性加载占位。 */
export function shouldShowConversationLoadingPlaceholder(input: {
  readonly loadStatus: ConversationLoadStatus | string;
  readonly messageCount: number;
}): boolean {
  if (input.messageCount > 0) return false;
  return input.loadStatus === 'loading' || input.loadStatus === 'idle';
}
