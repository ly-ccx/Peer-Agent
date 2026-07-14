import { useCallback, useRef } from 'react';

/**
 * 整轮 wall-clock 计时 hook —— 从 ChatSurface 下沉，行为保持不变。
 *
 * 设计要点（与原内联实现一致）：
 * - 计时真值来自 turnStartedAtRef（本轮起点时间戳），不累积 tick 漂移。
 * - turnStartedAtRef 暴露给调用方，用于在流事件里计算 turnDurationMs
 *   （done/aborted/error 落库时长）。
 * - 实时跳秒由最末端的 StreamingElapsedTime 组件负责，避免每秒重渲染整个 ChatSurface。
 */
export function useElapsedTimer() {
  const turnStartedAtRef = useRef<number | null>(null);

  const setTurnStartedAt = useCallback((startedAt: number | null) => {
    turnStartedAtRef.current = startedAt;
  }, []);

  return { turnStartedAtRef, setTurnStartedAt };
}
