import { useCallback, useState } from 'react';
import type { GoalPlan } from '@peer-agent/protocol';
import { clientApi } from '../../../clientApi';

/**
 * 计划「批准 / 驳回」的共享落库单元 —— 见 Goal 模式运行时闸门设计。
 *
 * 单一事实源：右侧 GoalPlanPanel 与聊天侧批准卡都调用本 hook 的 decide()，
 * 保证「批准/驳回」始终是同一条受治理链路（goalPlansApprove + confirmationId 的
 * 二元 HumanConfirmation），不会被降级为自由问答。
 *
 * 表达层职责：本 hook 只负责发起治理写操作并维护 busy/error 局部 UI 态；
 * 真正的「执行轮」由 main 进程 Goal Runner 托管推进（onApproved 仅为兼容旧的
 * 回调驱动路径，可选）。renderer 不直接碰 fs，全部经 clientApi → preload → IPC。
 */

export type GoalPlanDecision = 'approve' | 'reject';

export interface UseGoalPlanApprovalOptions {
  readonly isZh?: boolean;
  /**
   * 批准成功后的可选回调（旧的回调驱动执行路径）。新链路下执行由 main 托管，
   * 不传也能正常工作；GoalPlanPanel 仍传入以保持既有行为。
   */
  readonly onApproved?: (plan: GoalPlan) => void;
  /** 落库 + reload 完成后触发（成功路径，approve / reject 都会触发）。 */
  readonly onSettled?: (plan: GoalPlan, decision: GoalPlanDecision) => void | Promise<void>;
}

export interface UseGoalPlanApprovalResult {
  /** 当前正在处理的 planId（用于 busy 态渲染），空闲时为 null。 */
  readonly busyPlanId: string | null;
  /** 最近一次操作失败的错误信息，成功时为 null。 */
  readonly error: string | null;
  /** 发起批准 / 驳回。落库为带 confirmationId 的治理事实。 */
  readonly decide: (plan: GoalPlan, decision: GoalPlanDecision) => Promise<void>;
}

/**
 * 构建一次人工确认（HumanConfirmation）的批准事实。
 * confirmationId 为前端生成的占位，真正的执行链路会以运行时 HumanConfirmation 的 id 覆盖。
 */
function buildApproval(decision: GoalPlanDecision) {
  return {
    decision,
    confirmationId: `ui-${Date.now()}`,
    decidedAt: new Date().toISOString(),
  } as const;
}

export function useGoalPlanApproval(
  options: UseGoalPlanApprovalOptions = {},
): UseGoalPlanApprovalResult {
  const { isZh = false, onApproved, onSettled } = options;
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = useCallback(
    async (plan: GoalPlan, decision: GoalPlanDecision) => {
      setBusyPlanId(plan.planId);
      setError(null);
      try {
        await clientApi.goalPlansApprove({
          planId: plan.planId,
          approval: buildApproval(decision),
        });
        // 落库（治理事实）与执行驱动分离：store 已记录 GoalApproval Evidence。
        if (decision === 'approve') {
          onApproved?.(plan);
        }
        await onSettled?.(plan, decision);
      } catch (err) {
        setError(err instanceof Error ? err.message : isZh ? '操作失败' : 'Action failed');
      } finally {
        setBusyPlanId(null);
      }
    },
    [isZh, onApproved, onSettled],
  );

  return { busyPlanId, error, decide };
}
