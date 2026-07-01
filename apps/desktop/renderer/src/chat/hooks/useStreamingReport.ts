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

