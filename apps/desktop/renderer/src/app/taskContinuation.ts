import type { TaskOverviewItem } from '@peer-agent/protocol';

export interface TaskContinuationAction {
  readonly conversationId: string;
  /** goal_plan taskId is the planId; used to reopen the same plan when leaving result_ready. */
  readonly planId?: string;
  /**
   * true when the card is result_ready for a goal plan: continue discussion means
   * acceptance failed and the same plan should leave the acceptance queue.
   */
  readonly reopenUnacceptedResult: boolean;
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

  const reopenUnacceptedResult =
    item.source === 'goal_plan' && item.actionRight === 'result_ready' && Boolean(item.taskId?.trim());

  return {
    conversationId,
    planId: reopenUnacceptedResult ? item.taskId : undefined,
    reopenUnacceptedResult,
    label: isZh ? '继续讨论' : 'Continue discussion',
    description: isZh
      ? reopenUnacceptedResult
        ? '验收未通过，回到原任务继续改（同一张卡）'
        : '打开原会话继续追问或发起下一步'
      : reopenUnacceptedResult
        ? 'Acceptance failed — reopen the same task to continue (no new card)'
        : 'Open the original conversation to ask a follow-up or take the next step',
  };
}
