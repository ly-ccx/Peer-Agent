import { useEffect } from 'react';

/**
 * 把流式运行状态（含会话坐标）上报给上层 —— 从 ChatSurface 下沉，行为保持不变。
 *
 * 设计要点（与原内联实现一致）：
 * - 表达层只反映 isStreaming 真值，不引入新的执行真值；上层据此在左侧列表显示 Loading 图标。
 * - 依赖 [isStreaming, conversationId, onStreamingChange]，任一变化即重新上报。
 *
 * @param conversationId 当前会话 id（可为 null）。
 * @param isStreaming 当前是否处于流式运行中。
 * @param onStreamingChange 上报回调（可选）。
 */
export function useStreamingReport(
  conversationId: string | null,
  isStreaming: boolean,
  onStreamingChange?: (conversationId: string | null, isStreaming: boolean) => void,
): void {
  // 把流式运行状态(含会话坐标)上报给上层,供左侧列表显示 Loading 图标。
  // 表达层只反映 isStreaming 真值,不引入新的执行真值。
  useEffect(() => {
    onStreamingChange?.(conversationId, isStreaming);
  }, [isStreaming, conversationId, onStreamingChange]);
}

/**
 * 把上下文压缩状态（含会话坐标 + 进度百分比）上报给上层 —— 与 useStreamingReport 同款模式。
 *
 * 设计要点：
 * - 表达层只反映 isCompacting 真值，不引入新的执行真值；上层据此在左侧列表显示压缩指示。
 * - 压缩只发生在前台活跃会话（回合末自动压缩 / 手动 /compact），故无需 main 侧广播兜底。
 * - 依赖 [isCompacting, percent, conversationId, onCompactingChange]，任一变化即重新上报。
 *
 * @param conversationId 当前会话 id（可为 null）。
 * @param isCompacting 当前是否处于上下文压缩中。
 * @param percent 压缩进度百分比（0-100），尚无进度时为 null。
 * @param onCompactingChange 上报回调（可选）。
 */
export function useCompactingReport(
  conversationId: string | null,
  isCompacting: boolean,
  percent: number | null,
  onCompactingChange?: (
    conversationId: string | null,
    isCompacting: boolean,
    percent: number | null,
  ) => void,
): void {
  useEffect(() => {
    onCompactingChange?.(conversationId, isCompacting, percent);
  }, [isCompacting, percent, conversationId, onCompactingChange]);
}
