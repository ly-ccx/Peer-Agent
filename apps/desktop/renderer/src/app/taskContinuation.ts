import type { TaskOverviewItem } from '@peer-agent/protocol';

export interface TaskContinuationAction {
  readonly conversationId: string;
  readonly label: string;
  readonly description: string;
}

export interface TaskContinuationNavigation {
  readonly showActiveConversations: () => void;
  readonly selectConversation: (conversationId: string) => void;
  /** Close result drawer / result-only overlay if open. */
  readonly closeResult: () => void;
  /**
   * Open the conversation drawer bound to the selected conversation.
   * Must be mutually exclusive with tasks/history/result drawers (same Drawer layer).
   * Must NOT hard-switch the main page to Chat.
   */
  readonly openConversationDrawer: () => void;
  readonly focusComposer: () => void;
}

/**
 * Task continuation is navigation, not execution.
 *
 * The Conversation remains the Task identity. This action opens a closable
 * conversation drawer bound to that conversationId and lets the existing
 * composer / Goal intake decide whether the next user input is an Ask, a
 * continuation of the active Goal, or a new Goal.
 *
 * Product rule (peer-2-0-workbench-flow §14): 继续讨论 = Conversation Drawer,
 * not "close drawers + jump to main Chat".
 */
export function continueTaskInConversation(
  conversationId: string,
  navigation: TaskContinuationNavigation,
): void {
  navigation.showActiveConversations();
  navigation.selectConversation(conversationId);
  navigation.closeResult();
  navigation.openConversationDrawer();
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
    label: isZh ? '继续讨论' : 'Continue discussion',
    description: isZh
      ? '打开原会话继续追问或发起下一步'
      : 'Open the original conversation to ask a follow-up or take the next step',
  };
}
