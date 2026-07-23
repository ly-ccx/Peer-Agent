import { formatDuration } from './format.ts';
import type { SegmentGroup, ToolCallLegacy } from './types.ts';

/** 合并已完成工具区间，返回去重后的工具墙钟耗时；并行区间只计算一次。 */
export function calculateToolWallClockMs(tools: readonly ToolCallLegacy[]): number {
  const intervals = tools
    .filter((tool) => Number.isFinite(tool.startedAtMs) && Number.isFinite(tool.endedAtMs) && tool.endedAtMs! >= tool.startedAtMs!)
    .map((tool) => [tool.startedAtMs!, tool.endedAtMs!] as const)
    .sort((a, b) => a[0] - b[0]);
  if (intervals.length === 0) return 0;

  let total = 0;
  let [start, end] = intervals[0];
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return total + end - start;
}

/** 构建过程折叠条文案；durationMs 表示从本轮发送到结束的整轮墙钟时间。 */
export function buildProcessingSummary(
  groups: SegmentGroup[],
  durationMs: number | undefined,
  isActive: boolean,
  isZh: boolean,
): string {
  if (isActive) return isZh ? '正在思考' : 'Thinking';

  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    const tools = groups.flatMap((group) => group.type === 'tool-call-group' ? group.calls : []);
    const toolWallClockMs = calculateToolWallClockMs(tools);
    const totalLabel = isZh ? `总耗时 ${formatDuration(durationMs)}` : `Total time ${formatDuration(durationMs)}`;
    if (toolWallClockMs > 0) {
      return isZh
        ? `${totalLabel} · 工具 ${formatDuration(toolWallClockMs)}`
        : `${totalLabel} · Tools ${formatDuration(toolWallClockMs)}`;
    }
    return totalLabel;
  }

  const toolCallCount = groups.reduce(
    (count, group) => count + (group.type === 'tool-call-group' ? group.calls.length : 0),
    0,
  );
  if (toolCallCount > 0) {
    return isZh
      ? `已完成 ${toolCallCount} 次工具调用`
      : `Completed ${toolCallCount} tool call${toolCallCount > 1 ? 's' : ''}`;
  }

  return isZh ? '处理完成' : 'Completed';
}
