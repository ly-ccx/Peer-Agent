import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useMotionPresence —— 全局动效编排 helper（表达层，无第三方依赖）。
 *
 * 设计依据：动效体系设计稿 §2「轻量 JS 编排 helper」。收敛此前散落的三处重复实现：
 *   - components/Overlay.tsx 的 closing/finishClose/兜底定时器内联逻辑
 *   - components/UpdateToast.tsx 的收起编排
 *   - chat/hooks/useExitAnimation.ts 的 timer-only 退场
 *
 * 单一职责：解决「React 想卸载元素，但要先播完 CSS 退场动画再真删」这一时序问题。
 * 原理：startExit() → exiting=true（组件挂退场基元 class）→ CSS 播动画
 *       → onAnimationEnd 或兜底定时器触发 → onExitComplete() 真正卸载。
 *
 * 双保险：animationend 事件为主，fallback 定时器兜底——防止事件因元素被提前隐藏 /
 *         reduced-motion 降级（animation-duration:1ms）等原因丢失，导致元素卡死不卸载。
 *
 * reduced-motion：退场时长由 tokens.css 全局兜底压到 1ms，本 helper 的兜底定时器
 *                 仍会在 exitDurationMs 后收尾，因此降级场景下也能正确卸载（略有延迟，
 *                 但不会卡死）。如需即时卸载，可读 prefersReducedMotion() 自行短路。
 */
export interface MotionPresenceOptions {
  /** 退场动画结束后执行的真正卸载 / 关闭回调。 */
  readonly onExitComplete: () => void;
  /**
   * 退场动画时长（毫秒），用于设置兜底定时器。应 ≥ 实际退场基元时长。
   * 默认 240ms（略大于 --za-motion-medium=200ms，给合成与事件派发留余量）。
   */
  readonly exitDurationMs?: number;
}

export interface MotionPresenceApi {
  /** 是否处于退场态。组件据此挂 .motion-exit-* 基元 class。 */
  readonly exiting: boolean;
  /** 请求退场：进入退场态并播动画，结束后触发 onExitComplete。重复调用幂等。 */
  readonly startExit: () => void;
  /**
   * 绑定到执行退场动画的元素上的 onAnimationEnd。作为主收尾路径；
   * 未触发时由兜底定时器接管。仅在 exiting 时生效。
   */
  readonly onAnimationEnd: () => void;
}

/**
 * 探测用户是否偏好减少动效（prefers-reduced-motion: reduce）。
 * SSR / 非浏览器环境安全返回 false。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useMotionPresence(options: MotionPresenceOptions): MotionPresenceApi {
  const { onExitComplete, exitDurationMs = 240 } = options;
  const [exiting, setExiting] = useState(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneRef = useRef(false);

  // 最新的 onExitComplete 存入 ref，避免把它纳入 startExit 依赖导致回调抖动。
  const onExitCompleteRef = useRef(onExitComplete);
  useEffect(() => {
    onExitCompleteRef.current = onExitComplete;
  }, [onExitComplete]);

  const clearFallback = useCallback(() => {
    if (fallbackTimer.current) {
      clearTimeout(fallbackTimer.current);
      fallbackTimer.current = null;
    }
  }, []);

  // 收尾：清理定时器并执行一次真正卸载（幂等——animationend 与兜底不会重复触发）。
  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    clearFallback();
    onExitCompleteRef.current();
  }, [clearFallback]);

  const startExit = useCallback(() => {
    setExiting((prev) => {
      if (prev) return prev; // 已在退场，幂等
      return true;
    });
  }, []);

  // 进入退场态后启动兜底定时器；animationend 未如期到达时由它收尾。
  useEffect(() => {
    if (!exiting) return undefined;
    fallbackTimer.current = setTimeout(finish, exitDurationMs);
    return clearFallback;
  }, [exiting, exitDurationMs, finish, clearFallback]);

  // 卸载时清理，防止定时器泄漏。
  useEffect(() => clearFallback, [clearFallback]);

  const onAnimationEnd = useCallback(() => {
    if (!exiting) return;
    finish();
  }, [exiting, finish]);

  return { exiting, startExit, onAnimationEnd };
}
