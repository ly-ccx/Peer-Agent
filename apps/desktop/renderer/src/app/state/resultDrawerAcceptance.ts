import type { TaskOverviewItem } from '@peer-agent/protocol';

/** 打开结果抽屉时可选带上同线待签项，确认验收时一次签完。 */
export type OpenResultOptions = {
  readonly acceptTogether?: readonly TaskOverviewItem[];
};

export type OpenTaskOverviewItem = (
  item: TaskOverviewItem,
  options?: OpenResultOptions,
) => void;

export function collectPendingAcceptanceItems(
  items: readonly TaskOverviewItem[] | null | undefined,
): TaskOverviewItem[] {
  if (!items?.length) return [];
  const seen = new Set<string>();
  const pending: TaskOverviewItem[] = [];
  for (const item of items) {
    if (item.actionRight !== 'result_ready' || !item.taskId) continue;
    if (seen.has(item.taskId)) continue;
    seen.add(item.taskId);
    pending.push(item);
  }
  return pending;
}

/**
 * 结果抽屉点确认验收时要签的项。
 * - 归组卡「查看结果」带上 acceptTogether：签完这条线上全部待签项
 * - 单卡 / 点某一行打开：只签当前这一项
 */
export function resolveResultDrawerAcceptanceTargets(
  current: TaskOverviewItem,
  acceptTogether?: readonly TaskOverviewItem[] | null,
): TaskOverviewItem[] {
  const together = collectPendingAcceptanceItems(acceptTogether);
  if (together.length === 0) {
    return current.actionRight === 'result_ready' && current.taskId ? [current] : [];
  }
  if (
    current.actionRight === 'result_ready'
    && current.taskId
    && !together.some((item) => item.taskId === current.taskId)
  ) {
    return [current, ...together];
  }
  return together;
}
