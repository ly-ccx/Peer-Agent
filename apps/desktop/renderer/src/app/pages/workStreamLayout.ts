import type { TaskOverviewItem } from '@peer-agent/protocol';

/** Matches `.task-overview-work-stream` minmax(min(100%, 28rem), 1fr). */
export const WORK_STREAM_COLUMN_MIN_REM = 28;
export const WORK_STREAM_GAP_REM = 0.75;

/** Baseline chrome (header / title / progress / actions), plus one unit per extra row. */
const WORK_STREAM_CARD_BASE_WEIGHT = 4;

export function workStreamColumnCount(containerWidthPx: number, remPx = 16): 1 | 2 {
  if (containerWidthPx <= 0 || remPx <= 0) return 1;
  const twoColMinPx = (WORK_STREAM_COLUMN_MIN_REM * 2 + WORK_STREAM_GAP_REM) * remPx;
  return containerWidthPx >= twoColMinPx ? 2 : 1;
}

export function workStreamItemWeight(item: Pick<TaskOverviewItem, 'planSteps'>): number {
  return WORK_STREAM_CARD_BASE_WEIGHT + (item.planSteps?.length ?? 0);
}

/** Result cards grow with the goal-thread tree, not with leftover planSteps. */
export function resultCardWeight(threadNodeCount = 0): number {
  return WORK_STREAM_CARD_BASE_WEIGHT + Math.max(0, threadNodeCount);
}

/**
 * Left-to-right masonry: each next card drops into the currently shortest column
 * so a later short card can sit beside an earlier tall one.
 */
export function packWorkStreamColumns<T>(
  items: readonly T[],
  columnCount: number,
  weightOf: (item: T) => number,
): T[][] {
  const count = Math.max(1, Math.floor(columnCount));
  const columns = Array.from({ length: count }, () => [] as T[]);
  const heights = Array.from({ length: count }, () => 0);
  for (const item of items) {
    let target = 0;
    for (let index = 1; index < count; index += 1) {
      if (heights[index] < heights[target]) target = index;
    }
    columns[target].push(item);
    heights[target] += Math.max(0, weightOf(item));
  }
  return columns;
}

export function shouldPackWorkStream(itemCount: number, columnCount: number): boolean {
  return itemCount >= 3 && columnCount >= 2;
}
