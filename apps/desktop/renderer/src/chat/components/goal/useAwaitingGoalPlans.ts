import { useCallback, useEffect, useRef, useState } from 'react';
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

function shouldRefreshForConversation(
  payload: { conversationId?: string | null; planId?: string | null } | undefined,
  conversationId: string | null,
  knownPlanIds: ReadonlySet<string>,
): boolean {
  if (!conversationId) return false;
  const eventConversationId = normalizeConversationId(payload?.conversationId);
  if (eventConversationId) {
    return eventConversationId === conversationId;
  }
  const planId = typeof payload?.planId === 'string' ? payload.planId : null;
  // payload 缺 conversationId 时：planId 已知属于本会话则刷新；尚无基线时保守刷新。
  if (planId) return knownPlanIds.size === 0 || knownPlanIds.has(planId);
  return true;
}

export function useAwaitingGoalPlans(
  conversationId: string | null,
  enabled = true,
): readonly GoalPlan[] {
  const [awaitingPlans, setAwaitingPlans] = useState<readonly GoalPlan[]>([]);
  const normalizedConversationId = normalizeConversationId(conversationId);
  const knownPlanIdsRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Promise<void> | null>(null);
  const reloadQueuedRef = useRef(false);
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    if (!enabled || !normalizedConversationId) {
      knownPlanIdsRef.current = new Set();
      setAwaitingPlans([]);
      return;
    }

    if (inFlightRef.current) {
      reloadQueuedRef.current = true;
      await inFlightRef.current;
      return;
    }

    const requestId = ++requestIdRef.current;
    const task = (async () => {
      try {
        const result = await clientApi.goalPlansList({ conversationId: normalizedConversationId });
        if (requestId !== requestIdRef.current) return;
        const scoped = result.filter(
          (plan) =>
            normalizeConversationId(plan.conversationId) === normalizedConversationId &&
            plan.status === 'awaiting_approval',
        );
        knownPlanIdsRef.current = new Set(scoped.map((plan) => plan.planId));
        setAwaitingPlans(scoped);
      } catch {
        // 只读视图：拉取失败时不阻断聊天，保持空列表（右侧面板仍是权威入口）。
        if (requestId === requestIdRef.current) setAwaitingPlans([]);
      }
    })();

    inFlightRef.current = task;
    try {
      await task;
    } finally {
      if (inFlightRef.current === task) inFlightRef.current = null;
      if (reloadQueuedRef.current) {
        reloadQueuedRef.current = false;
        void reload();
      }
    }
  }, [enabled, normalizedConversationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 任一写路径（IPC 或 AI 工具）改动计划后 main 广播 goalPlans:changed，这里据此重拉。
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = clientApi.onGoalPlansChanged((payload) => {
      // runner 进度计数不影响 awaiting_approval 列表。
      if (payload?.changeKind === 'runner-progress') return;
      if (
        !shouldRefreshForConversation(
          payload,
          normalizedConversationId,
          knownPlanIdsRef.current,
        )
      ) {
        return;
      }
      void reload();
    });
    return unsubscribe;
  }, [enabled, normalizedConversationId, reload]);

  return awaitingPlans;
}

/**
 * 左侧会话列表的只读待批准聚合视图。
 *
 * 服务端聚合 awaiting_approval 计数（goalPlansAwaitingCounts），不再全量 goalPlansList。
 * 批准/驳回/新建计划会触发 goalPlans:changed 广播并重拉，列表徽标与右侧面板同步消解。
 */
export function useAwaitingGoalPlanCounts(enabled = true): ReadonlyMap<string, number> {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const inFlightRef = useRef<Promise<void> | null>(null);
  const reloadQueuedRef = useRef(false);
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    if (!enabled) {
      setCounts(new Map());
      return;
    }
    if (inFlightRef.current) {
      reloadQueuedRef.current = true;
      return inFlightRef.current;
    }
    const requestId = ++requestIdRef.current;
    const run = (async () => {
      try {
        const raw = await clientApi.goalPlansAwaitingCounts();
        if (requestId !== requestIdRef.current) return;
        const next = new Map<string, number>();
        if (raw && typeof raw === 'object') {
          for (const [conversationId, count] of Object.entries(raw)) {
            const n = Number(count);
            if (!conversationId || !Number.isFinite(n) || n <= 0) continue;
            next.set(conversationId, n);
          }
        }
        setCounts((prev) => {
          if (prev.size !== next.size) return next;
          for (const [conversationId, count] of next) {
            if (prev.get(conversationId) !== count) return next;
          }
          return prev;
        });
      } catch {
        if (requestId === requestIdRef.current) {
          setCounts((prev) => (prev.size === 0 ? prev : new Map()));
        }
      } finally {
        inFlightRef.current = null;
        if (reloadQueuedRef.current) {
          reloadQueuedRef.current = false;
          void reload();
        }
      }
    })();
    inFlightRef.current = run;
    return run;
  }, [enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = clientApi.onGoalPlansChanged((payload) => {
      // 全量聚合仍忽略 runner-progress，避免高频计数触发无意义 list。
      if (payload?.changeKind === 'runner-progress') return;
      void reload();
    });
    return unsubscribe;
  }, [enabled, reload]);

  return counts;
}
