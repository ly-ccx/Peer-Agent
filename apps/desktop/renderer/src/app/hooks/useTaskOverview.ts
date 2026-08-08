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
  readonly workspacePath?: string | null;
  readonly includeTerminal?: boolean;
  readonly activeWithinMs?: number;
  readonly limit?: number;
};

export function useTaskOverview(
  options: UseTaskOverviewOptions | boolean = true,
): readonly TaskOverviewItem[] {
  const opts: UseTaskOverviewOptions =
    typeof options === 'boolean' ? { enabled: options } : (options ?? {});
  const enabled = opts.enabled !== false;
  const workspacePath = opts.workspacePath ?? null;
  const includeTerminal = opts.includeTerminal === true;
  const activeWithinMs = opts.activeWithinMs;
  const limit = opts.limit;

  const [items, setItems] = useState<readonly TaskOverviewItem[]>([]);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const reloadQueuedRef = useRef(false);
  const requestIdRef = useRef(0);

  const reload = useCallback(async () => {
    if (!enabled) {
      setItems([]);
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
          includeTerminal,
          ...(Number.isFinite(activeWithinMs) ? { activeWithinMs } : {}),
          ...(Number.isFinite(limit) ? { limit } : {}),
        });
        if (requestId !== requestIdRef.current) return;
        setItems(result);
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
  }, [enabled, workspacePath, includeTerminal, activeWithinMs, limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // main 在 goalPlans:changed / automations:changed 时 fan-out 广播
  // taskOverview:changed，这里据此重拉，保持三页面与后端事实同步。
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribe = clientApi.onTaskOverviewChanged(() => {
      void reload();
    });
    return unsubscribe;
  }, [enabled, reload]);

  return items;
}
