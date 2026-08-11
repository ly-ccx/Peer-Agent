/**
 * 会话主区空态/加载门控（纯函数，便于单测）。
 *
 * 切会话时 beginLoad 会先清空 messages 并把 loadStatus 置为 loading。
 * 若 UI 只看 messages.length === 0，会在加载完成前误显空白首页。
 * 空首页仅应在 loadStatus === 'ready' 且无消息时出现。
 */

export type ConversationLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export type DayPeriod = 'morning' | 'afternoon' | 'evening';

/** 首页问候只依赖本地小时，避免把时间逻辑散落在渲染组件中。 */
export function resolveDayPeriod(hour: number): DayPeriod {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

export function conversationHomeGreeting(
  hour: number,
  isZh: boolean,
  workspaceLabel?: string | null,
): string {
  const period = resolveDayPeriod(hour);
  const label = workspaceLabel?.trim() || null;

  // 有工作区时优先在标题展示工作区名（用户明确要求保留在标题上）。
  if (label) {
    if (isZh) {
      if (period === 'morning') return `早上好，接下来在 ${label} 想做点什么？`;
      if (period === 'afternoon') return `下午好，接下来在 ${label} 想推进什么？`;
      return `晚上好，接下来在 ${label} 想做点什么？`;
    }
    if (period === 'morning') return `Good morning. What would you like to do in ${label}?`;
    if (period === 'afternoon') return `Good afternoon. What would you like to move forward in ${label}?`;
    return `Good evening. What would you like to do in ${label}?`;
  }

  if (isZh) {
    if (period === 'morning') return '早上好，接下来想做点什么？';
    if (period === 'afternoon') return '下午好，今天想推进什么？';
    return '晚上好，接下来想做点什么？';
  }
  if (period === 'morning') return 'Good morning. What would you like to do?';
  if (period === 'afternoon') return 'Good afternoon. What would you like to move forward?';
  return 'Good evening. What would you like to do next?';
}

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
