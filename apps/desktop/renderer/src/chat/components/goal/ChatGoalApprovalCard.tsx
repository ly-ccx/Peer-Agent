import { useContext } from 'react';
import type { ReactElement } from 'react';
import type { GoalPlan } from '@peer-agent/protocol';
import { InteractionContext } from '../thread/interactionContext';
import { goalPlanNextStepCopy } from './goalPlanNextActions';
import { useGoalPlanApproval } from './useGoalPlanApproval';
import { useAwaitingGoalPlans } from './useAwaitingGoalPlans';

/**
 * 聊天侧「受治理批准卡」 —— 见 Goal 模式运行时闸门设计。
 *
 * 当存在 status === 'awaiting_approval' 的计划时，在聊天流内镜像一张
 * 「批准并执行 / 驳回」卡。点击复用 useGoalPlanApproval（与右侧 GoalPlanPanel
 * 同一条 goalPlansApprove + confirmationId 治理链路），批准/驳回后随 goalPlans:changed
 * 广播刷新，与右侧状态互相消解。
 *
 * 治理红线：这是受治理的二元闸门（批准/驳回），不解析模型生成的自由文本选项，
 * 也不把批准降级为自由问答。实质性追问仍走 request_user_input 文本路径，二者正交。
 */

export function ChatGoalApprovalCard({
  conversationId,
  isZh,
  isStreaming,
  enabled = true,
}: {
  readonly conversationId: string | null;
  readonly isZh: boolean;
  readonly isStreaming: boolean;
  readonly enabled?: boolean;
}): ReactElement | null {
  const awaitingPlans = useAwaitingGoalPlans(conversationId, enabled);
  const { busyPlanId, error, decide } = useGoalPlanApproval({ isZh });
  const interaction = useContext(InteractionContext);
  const copy = goalPlanNextStepCopy(isZh);

  if (!enabled || awaitingPlans.length === 0) return null;

  return (
    <div className="chat-goal-approval">
      {awaitingPlans.map((plan: GoalPlan) => {
        const busy = busyPlanId === plan.planId;
        // 生成中禁止批准：与右侧面板一致，等本轮输出结束再批准。
        const disabled = busy || isStreaming;
        return (
          <div key={plan.planId} className="chat-goal-approval-card" role="group">
            <div className="chat-goal-approval-head">
              <span className="chat-goal-approval-badge">
                {isZh ? '待批准' : 'Awaiting approval'}
              </span>
              <span className="chat-goal-approval-title">{plan.title}</span>
            </div>
            {plan.goal ? (
              <div className="chat-goal-approval-goal">{plan.goal}</div>
            ) : null}
            <div className="chat-goal-next-guidance">{copy.guidance}</div>
            <div className="chat-goal-approval-actions" data-goal-plan-next-actions>
              <button
                type="button"
                className="chat-goal-approval-btn chat-goal-approval-btn--approve"
                disabled={disabled}
                title={
                  isStreaming
                    ? isZh
                      ? '请等待本轮输出结束后再批准'
                      : 'Wait until this turn finishes before approving'
                    : undefined
                }
                onClick={() => {
                  void decide(plan, 'approve');
                }}
              >
                {copy.start}
              </button>
              <button
                type="button"
                className="chat-goal-approval-btn chat-goal-approval-btn--adjust"
                disabled={disabled || !interaction}
                onClick={() => interaction?.onSelectOption(copy.adjustmentMessage)}
              >
                {copy.adjust}
              </button>
              <button
                type="button"
                className="chat-goal-approval-btn chat-goal-approval-btn--reject"
                disabled={disabled}
                onClick={() => {
                  void decide(plan, 'reject');
                }}
              >
                {copy.cancel}
              </button>
            </div>
          </div>
        );
      })}
      {error ? <div className="chat-goal-approval-error">{error}</div> : null}
    </div>
  );
}
