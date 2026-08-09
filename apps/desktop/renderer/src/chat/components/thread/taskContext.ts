import type { TaskOverviewItem } from '@peer-agent/protocol';

export interface ChatTaskContextView {
  readonly statusLabel: string;
  readonly currentGoalTitle?: string;
  readonly detailLabel: string;
}

/**
 * Chat header only renders the governed TaskOverview projection. It does not
 * infer GoalPlan state or manufacture plan progress for a discussion.
 */
export function projectChatTaskContext(
  item: TaskOverviewItem | undefined,
  isZh: boolean,
): ChatTaskContextView | null {
  if (!item?.conversationId) return null;
  return {
    statusLabel: item.statusLabel,
    ...(item.currentGoalTitle ? { currentGoalTitle: item.currentGoalTitle } : {}),
    detailLabel: isZh ? '任务详情' : 'Task details',
  };
}
