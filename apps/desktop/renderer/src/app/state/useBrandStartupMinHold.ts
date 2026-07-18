import { useEffect, useState } from 'react';

/**
 * 品牌启动页入场动画时长（与 shell.css / motion.css 中 2.2s 关键）。
 * 冷启动优化后 bootstrap 可能远快于动画，必须用最短展示时长保住 LOGO 过渡页。
 */
export const BRAND_STARTUP_INTRO_MS = 2200;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * 冷启动最短品牌页门闩：挂载后至少展示 intro 动画时长，
 * reduced-motion 下立即放行。与 session 是否就绪取「两者都满足」才进主界面。
 */
export function useBrandStartupMinHold(enabled = true): boolean {
  const [holdDone, setHoldDone] = useState(() => !enabled || prefersReducedMotion());

  useEffect(() => {
    if (!enabled) {
      setHoldDone(true);
      return;
    }
    if (prefersReducedMotion()) {
      setHoldDone(true);
      return;
    }
    setHoldDone(false);
    const timer = window.setTimeout(() => {
      setHoldDone(true);
    }, BRAND_STARTUP_INTRO_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [enabled]);

  return holdDone;
}
