import type { TaskOverviewItem } from '@peer-agent/protocol';

export interface TaskContinuationAction {
  readonly conversationId: string;
  readonly label: string;
  readonly description: string;
}

export interface TaskContinuationNavigation {
  readonly showActiveConversations: () => void;
  readonly selectConversation: (conversationId: string) => void;
  readonly closeResult: () => void;
  readonly closeCollection: () => void;
  readonly showChat: () => void;
  readonly focusComposer: () => void;
}

/**
 * Task continuation is navigation, not execution.
 *
 * The Conversation remains the Task identity. This action only restores that
 * conversation and lets the existing composer / Goal intake decide whether the
 * next user input is an Ask, a continuation of the active Goal, or a new Goal.
 */
export function continueTaskInConversation(
  conversationId: string,
  navigation: TaskContinuationNavigation,
): void {
  navigation.showActiveConversations();
  navigation.selectConversation(conversationId);
  navigation.closeResult();
  navigation.closeCollection();
  navigation.showChat();
  navigation.focusComposer();
}

export function getTaskContinuationAction(
  item: TaskOverviewItem,
  isZh: boolean,
): TaskContinuationAction | null {
  const conversationId = item.conversationId?.trim();
  if (!conversationId) return null;

  return {
    conversationId,
    label: isZh ? '继续任务' : 'Continue task',
    description: isZh
      ? '回到原任务，继续追问或发起下一步'
      : 'Return to the original task to ask a follow-up or take the next step',
  };
}
