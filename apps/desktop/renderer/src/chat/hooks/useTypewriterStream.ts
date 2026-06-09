import { useCallback, useEffect, useRef } from 'react';

/**
 * 平滑流式打字机泵。
 *
 * 解决"生硬吐字"问题：网络/模型按自己的节奏（大块、不均匀）推送 delta，
 * 但显示层用独立的、自适应速率的 requestAnimationFrame 循环按字符匀速吐出，
 * 让用户始终看到丝滑连续的文字流，而不是一坨一坨地跳。
 *
 * 设计要点：
 * - 接收与显示解耦：push() 只往 buffer 追加，绝不直接触发渲染。
 * - 自适应速率：buffer 积压越多，每帧吐字越快，保证显示不会落后网络太久。
 * - 帧级批处理：一帧最多调用一次 onText，告别"每个 chunk 一次 setState"。
 * - flush()：流结束时立刻把剩余 buffer 全部吐出，避免末尾延迟。
 */

export interface TypewriterOptions {
  /** 每帧最少吐出的字符数（buffer 不空时的下限） */
  readonly minCharsPerFrame?: number;
  /** 每帧最多吐出的字符数（防止超大 buffer 一帧全吐导致不平滑） */
  readonly maxCharsPerFrame?: number;
  /**
   * 期望在多少帧内把当前积压消化完。越小越快、越激进。
   * 实际速率 = ceil(buffer.length / framesToDrain)，再 clamp 到 [min, max]。
   */
  readonly framesToDrain?: number;
}

const DEFAULTS: Required<TypewriterOptions> = {
  minCharsPerFrame: 1,
  maxCharsPerFrame: 90,
  framesToDrain: 18,
};

export interface TypewriterController {
  /** 追加新收到的文本片段（来自网络 delta） */
  push: (text: string) => void;
  /** 立即吐出全部剩余 buffer 并停止泵（流正常结束时调用） */
  flush: () => void;
  /** 丢弃 buffer 并停止泵（中断/出错/切换会话时调用） */
  reset: () => void;
}

export function useTypewriterStream(
  onText: (chunk: string) => void,
  options: TypewriterOptions = {},
): TypewriterController {
  const opts = { ...DEFAULTS, ...options };
  const bufferRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const tick = useCallback(() => {
    const buffer = bufferRef.current;
    if (buffer.length === 0) {
      // buffer 空了：暂停泵，等下一次 push 再启动，避免空转。
      rafRef.current = null;
      return;
    }
    // 自适应速率：积压越多吐越快。
    const target = Math.ceil(buffer.length / opts.framesToDrain);
    const take = Math.max(opts.minCharsPerFrame, Math.min(opts.maxCharsPerFrame, target));
    const chunk = buffer.slice(0, take);
    bufferRef.current = buffer.slice(take);
    onTextRef.current(chunk);
    rafRef.current = requestAnimationFrame(tick);
  }, [opts.framesToDrain, opts.minCharsPerFrame, opts.maxCharsPerFrame]);

  const ensureRunning = useCallback(() => {
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [tick]);

  const push = useCallback((text: string) => {
    if (!text) return;
    bufferRef.current += text;
    ensureRunning();
  }, [ensureRunning]);

  const flush = useCallback(() => {
    stopLoop();
    const remaining = bufferRef.current;
    bufferRef.current = '';
    if (remaining) onTextRef.current(remaining);
  }, [stopLoop]);

  const reset = useCallback(() => {
    stopLoop();
    bufferRef.current = '';
  }, [stopLoop]);

  // 组件卸载时清理 rAF，防止泄漏。
  useEffect(() => stopLoop, [stopLoop]);

  return { push, flush, reset };
}
