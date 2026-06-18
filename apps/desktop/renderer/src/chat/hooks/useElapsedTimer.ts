import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 整轮 wall-clock 计时 hook —— 从 ChatSurface 下沉，行为保持不变。
 *
 * 设计要点（与原内联实现一致）：
 * - 计时真值来自 turnStartedAtRef（本轮起点时间戳），定时器只负责「触发重渲染」，
 *   即便 tick 漂移也以起点时间戳为准，不累积误差。
 * - elapsedMs 驱动右下角实时跳秒；turnStartedAtRef 暴露给调用方，用于在流事件里
 *   计算 turnDurationMs（done/aborted/error 落库时长）。
 * - 仅当 isStreaming 为真时运行每秒定时器；isStreaming 转 false 时清理定时器。
 *
 * @param isStreaming 当前是否处于流式运行中（计时器开关）。
 */
export function useElapsedTimer(isStreaming: boolean) {
  // 整轮 wall-clock 计时：turnStartedAtRef 记录本轮起点（发送时），elapsedMs 驱动右下角实时跳秒。
  const turnStartedAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const setTurnStartedAt = useCallback((startedAt: number | null) => {
    turnStartedAtRef.current = startedAt;
    setElapsedMs(startedAt == null ? 0 : Math.max(0, Date.now() - startedAt));
  }, []);

  // 本轮运行时每秒刷新一次 elapsedMs（实时跳秒）。计时真值来自 turnStartedAtRef，
  // 故定时器只负责「触发重渲染」，即便 tick 漂移也以起点时间戳为准，不累积误差。
  useEffect(() => {
    if (!isStreaming) return;
    const tick = () => {
      const startedAt = turnStartedAtRef.current;
      if (startedAt != null) setElapsedMs(Date.now() - startedAt);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [isStreaming]);

  return { elapsedMs, turnStartedAtRef, setTurnStartedAt };
}
