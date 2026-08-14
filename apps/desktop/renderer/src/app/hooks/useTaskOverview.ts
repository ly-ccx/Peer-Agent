import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

/**
 * TaskOverview 行动权投影只读视图 —— Peer 2.0 阶段 2。
 *
 * 治理红线（AGENTS.md / peer-2-0-gap-analysis §11）：
 * - 渲染判定的唯一事实来源是 main 进程 taskOverview:list 返回的
 *   TaskOverviewItem[]（已含 actionRight / statusLabel / actionLabel），
 *   前端不解析 GoalPlanStatus / AutomationRunStatus，不推断行动权。
 * - 通过 taskOverviewList 拉取 + 订阅 taskOverview:changed 广播重拉。
 *
 * 数据边界：
 * - workspacePath：当前 Workspace，避免跨仓历史灌首页。
 * - includeTerminal：历史页传 true；首页/任务页默认 false。
 * - limit / activeWithinMs：由聚合层默认（48 条 / 7 天），调用方可覆盖。
 */
export type UseTaskOverviewOptions = {
  readonly enabled?: boolean;
  /** 主进程命令完成后由调用方递增，立即重拉权威投影。 */
  readonly refreshKey?: number;
  readonly workspacePath?: string | null;
  readonly conversationId?: string | null;
  readonly includeTerminal?: boolean;
  readonly activeWithinMs?: number;
  readonly limit?: number;
};

function areTaskOverviewItemsEqual(
  current: readonly TaskOverviewItem[],
  next: readonly TaskOverviewItem[],
): boolean {
  if (current === next) return true;
  if (current.length !== next.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (JSON.stringify(current[index]) !== JSON.stringify(next[index])) return false;
  }
  return true;
}

/**
 * 广播 payload 的相关性判定（性能治理，见知识库 multi-task-ui-performance-remediation §12）：
 * main 进程 taskOverview:changed 现已节流（最小 2s）并携带合并 scope；
 * 当 payload 声明 scoped 且与当前 hook 的查询条件无交集时，跳过重拉。
 * 兼容旧 payload（无 scoped 字段）：一律视为相关，保持行为不变。
 */
function isRelevantTaskOverviewChange(
  payload: unknown,
  opts: { conversationId: string | null },
): boolean {
  if (payload === null || typeof payload !== 'object') return true;
  const scope = payload as { scoped?: unknown; conversationIds?: unknown; planIds?: unknown };
  if (scope.scoped !== true) return true; // 未声明 scope（旧版/风暴退化）：保守重拉
  const ids = Array.isArray(scope.conversationIds) ? scope.conversationIds : null;
  if (!ids || ids.length === 0) return true; // scoped 但无会话粒度：重拉
  // 查询本身是全局视图（无 conversationId 过滤）：任何变更都可能影响列表。
  if (!opts.conversationId) return true;
  return ids.some((id) => typeof id === 'string' && id === opts.conversationId);
}

export function useTaskOverview(
  options: UseTaskOverviewOptions | boolean = true,
): readonly TaskOverviewItem[] {
  const opts: UseTaskOverviewOptions =
    typeof options === 'boolean' ? { enabled: options } : (options ?? {});
  const enabled = opts.enabled !== false;
  const refreshKey = opts.refreshKey ?? 0;
  const workspacePath = opts.workspacePath ?? null;
  const conversationId = opts.conversationId ?? null;
  const includeTerminal = opts.includeTerminal === true;
  const activeWithinMs = opts.activeWithinMs;
  const limit = opts.limit;

  const [items, setItems] = useState<readonly TaskOverviewItem[]>([]);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const reloadQueuedRef = useRef(false);
  const requestIdRef = useRef(0);
  // document.hidden 期间收到广播时置位；恢复可见立即同步一次（§12 性能治理）。
  const pendingVisibleReloadRef = useRef(false);

  const reload = useCallback(async () => {
    if (!enabled) {
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
        const result = await clientApi.taskOverviewList({
          workspacePath: workspacePath ?? undefined,
          conversationId: conversationId ?? undefined,
          includeTerminal,
          ...(Number.isFinite(activeWithinMs) ? { activeWithinMs } : {}),
          ...(Number.isFinite(limit) ? { limit } : {}),
        });
        if (requestId !== requestIdRef.current) return;
        setItems((current) => areTaskOverviewItemsEqual(current, result) ? current : result);
      } catch {
        // 只读投影：拉取失败保持空列表，不阻断页面渲染。
        if (requestId === requestIdRef.current) setItems([]);
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
  }, [enabled, refreshKey, workspacePath, conversationId, includeTerminal, activeWithinMs, limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // main 在 goalPlans:changed / automations:changed 时 fan-out 广播
  // taskOverview:changed，这里据此重拉，保持三页面与后端事实同步。
  // 性能治理（§12）：按 payload scope 过滤无关变更；document.hidden 时暂存不重拉，
  // 恢复可见立即同步一次，避免后台窗口参与广播风暴。
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = clientApi.onTaskOverviewChanged((payload: unknown) => {
      if (document.hidden) {
        pendingVisibleReloadRef.current = true;
        return;
      }
      if (!isRelevantTaskOverviewChange(payload, { conversationId })) return;
      void reload();
    });
    return unsubscribe;
  }, [enabled, conversationId, reload]);

  // 后台 shell 线程目前没有 changed 广播；轻量轮询保证工作台「Peer 正在推进」及时出现/消失。
  // 性能治理（§12）：document.hidden 时暂停轮询（后台窗口不做同步 IO），
  // 恢复可见时立即同步一次补上后台期间的变更。
  useEffect(() => {
    if (!enabled) return undefined;
    const onVisibilityChange = () => {
      if (!document.hidden && pendingVisibleReloadRef.current) {
        pendingVisibleReloadRef.current = false;
        void reload();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [enabled, reload]);

  useEffect(() => {
    if (!enabled) return undefined;
    if (document.hidden) return () => {};
    const timer = window.setInterval(() => {
      void reload();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [enabled, reload]);

  return items;
}
