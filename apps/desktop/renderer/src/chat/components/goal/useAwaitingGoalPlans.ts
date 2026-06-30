import { useCallback, useEffect, useState } from 'react';
import type { GoalPlan } from '@peer-agent/protocol';
import { clientApi } from '../../../clientApi';

/**
 * 聊天侧「当前待批准计划」只读视图 —— 见 Goal 模式运行时闸门设计。
 *
 * 渲染判定的唯一事实来源是 plan.status === 'awaiting_approval'（计划状态），
 * 绝不解析模型生成的 request_user_input 自由文本选项。与右侧 GoalPlanPanel 共享
 * 同一份后端事实：通过 goalPlansList 拉取 + 订阅 goalPlans:changed 广播重拉，
 * 批准/驳回后两侧状态自然同步消解。
 */

function normalizeConversationId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function useAwaitingGoalPlans(
  conversationId: string | null,
  enabled = true,
): readonly GoalPlan[] {
  const [awaitingPlans, setAwaitingPlans] = useState<readonly GoalPlan[]>([]);
  const normalizedConversationId = normalizeConversationId(conversationId);

  const reload = useCallback(async () => {
    if (!enabled || !normalizedConversationId) {
      setAwaitingPlans([]);
      return;
    }
    try {
      const result = await clientApi.goalPlansList({ conversationId: normalizedConversationId });
      const scoped = result.filter(
        (plan) =>
          normalizeConversationId(plan.conversationId) === normalizedConversationId &&
          plan.status === 'awaiting_approval',
      );
      setAwaitingPlans(scoped);
    } catch {
      // 只读视图：拉取失败时不阻断聊天，保持空列表（右侧面板仍是权威入口）。
      setAwaitingPlans([]);
    }
  }, [enabled, normalizedConversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 任一写路径（IPC 或 AI 工具）改动计划后 main 广播 goalPlans:changed，这里据此重拉。
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = clientApi.onGoalPlansChanged(() => {
      void reload();
    });
    return unsubscribe;
  }, [enabled, reload]);

  return awaitingPlans;
}
