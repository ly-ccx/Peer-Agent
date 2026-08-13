import type { TaskOverviewItem } from '@peer-agent/protocol';

export interface TaskContinuationAction {
  readonly conversationId: string;
  readonly label: string;
  readonly description: string;
}

export interface TaskContinuationNavigation {
  readonly showActiveConversations: () => void;
  readonly selectConversation: (conversationId: string) => void;
  /** Open a child conversation drawer without unmounting the result drawer beneath it. */
  readonly openConversationDrawer: () => void;
  /** Focus the drawer composer after mount. */
  readonly focusComposer?: () => void;
}

/**
 * §14 续接入口：只恢复 Task 现场，不跳主 Chat。
 * 待验收（result_ready）上的继续讨论 = 验收未通过，同 plan 续接，不叠新卡。
 */
export function continueTaskInConversation(
  conversationId: string,
  nav: TaskContinuationNavigation,
): void {
  const id = conversationId?.trim();
  if (!id) return;

  nav.showActiveConversations();
  nav.selectConversation(id);
  nav.openConversationDrawer();
  nav.focusComposer?.();
}

/**
 * Derive the "continue discussion" action for a TaskOverview item.
 * Returns null when there is no conversation to reopen.
 */
export function getTaskContinuationAction(
  item: Pick<TaskOverviewItem, 'conversationId' | 'source' | 'actionRight' | 'taskId'>,
  isZh: boolean,
): TaskContinuationAction | null {
  const conversationId = item.conversationId?.trim();
  if (!conversationId) return null;

  const isRejectingResult = item.actionRight === 'result_ready';
  return {
    conversationId,
    label: isRejectingResult
      ? (isZh ? '还不行' : 'Not yet')
      : (isZh ? '继续讨论' : 'Continue discussion'),
    description: isRejectingResult
      ? (isZh
        ? '打开对应会话并聚焦输入框；在对话里说明哪里不对'
        : 'Open the original conversation and focus the input so you can say what is wrong')
      : (isZh
        ? '打开原会话；发送消息后才会创建新的用户回合'
        : 'Open the original conversation; a new user turn starts only after you send a message'),
  };
}
