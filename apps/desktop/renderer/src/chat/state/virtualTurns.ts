export const DEFAULT_TURN_ESTIMATE_PX = 360;
export const DEFAULT_TURN_OVERSCAN_PX = 900;

export interface VirtualTurnItem {
  readonly index: number;
  readonly start: number;
  readonly size: number;
  readonly end: number;
}

export interface VirtualTurnRange {
  readonly items: readonly VirtualTurnItem[];
  readonly totalSize: number;
  readonly paddingStart: number;
  readonly paddingEnd: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface VirtualTurnRangeInput {
  readonly count: number;
  readonly scrollTop: number;
  readonly viewportSize: number;
  readonly measuredSizes: ReadonlyMap<number, number>;
  readonly estimateSize?: number;
  readonly overscanPx?: number;
  readonly forceIndex?: number | null;
}

function normalizedSize(value: number | undefined, estimateSize: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : estimateSize;
}

/**
 * 计算动态高度轮次的窗口范围。纯函数便于用长会话压力数据做稳定回归。
 * forceIndex 用于消息轨跳转：目标轮次即使尚未进入当前窗口也会被挂载。
 */
export function calculateVirtualTurnRange({
  count,
  scrollTop,
  viewportSize,
  measuredSizes,
  estimateSize = DEFAULT_TURN_ESTIMATE_PX,
  overscanPx = DEFAULT_TURN_OVERSCAN_PX,
  forceIndex = null,
}: VirtualTurnRangeInput): VirtualTurnRange {
  if (count <= 0) {
    return {
      items: [],
      totalSize: 0,
      paddingStart: 0,
      paddingEnd: 0,
      startIndex: 0,
      endIndex: -1,
    };
  }

  const sizes = Array.from({ length: count }, (_, index) =>
    normalizedSize(measuredSizes.get(index), estimateSize),
  );
  const starts: number[] = new Array(count);
  let totalSize = 0;
  for (let index = 0; index < count; index += 1) {
    starts[index] = totalSize;
    totalSize += sizes[index]!;
  }

  const windowStart = Math.max(0, scrollTop - overscanPx);
  const windowEnd = Math.max(windowStart, scrollTop + Math.max(0, viewportSize) + overscanPx);

  let startIndex = 0;
  while (startIndex < count - 1 && starts[startIndex]! + sizes[startIndex]! < windowStart) {
    startIndex += 1;
  }

  let endIndex = startIndex;
  while (endIndex < count - 1 && starts[endIndex + 1]! < windowEnd) {
    endIndex += 1;
  }

  if (
    typeof forceIndex === 'number'
    && forceIndex >= 0
    && forceIndex < count
    && (forceIndex < startIndex || forceIndex > endIndex)
  ) {
    // 跳转目标在当前窗口外时只挂载目标本身，不能把中间几十轮全部带入 DOM。
    startIndex = forceIndex;
    endIndex = forceIndex;
  }

  const items: VirtualTurnItem[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const start = starts[index]!;
    const size = sizes[index]!;
    items.push({ index, start, size, end: start + size });
  }

  const paddingStart = starts[startIndex] ?? 0;
  const renderedEnd = items.at(-1)?.end ?? paddingStart;
  return {
    items,
    totalSize,
    paddingStart,
    paddingEnd: Math.max(0, totalSize - renderedEnd),
    startIndex,
    endIndex,
  };
}

export function estimateVirtualTurnOffset(
  index: number,
  count: number,
  measuredSizes: ReadonlyMap<number, number>,
  estimateSize = DEFAULT_TURN_ESTIMATE_PX,
): number {
  const safeIndex = Math.max(0, Math.min(index, count));
  let offset = 0;
  for (let current = 0; current < safeIndex; current += 1) {
    offset += normalizedSize(measuredSizes.get(current), estimateSize);
  }
  return offset;
}
