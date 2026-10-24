import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { watchVisualMotion } from '../state/visualMotion';

/** Release entrance fill once per actual opening/object, without a component timer. */
export function useMotionSettled(root: RefObject<HTMLElement | null>, active: boolean, identity?: unknown) {
  const generation = useMemo(() => ({}), [active, identity]);
  const [settled, setSettled] = useState<object | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    let animations: Animation[] = [];
    try { animations = root.current?.getAnimations?.() ?? []; } catch { /* Static entrance. */ }
    const motion = watchVisualMotion(animations, () => setSettled(generation));
    return motion.cancel;
  }, [root, active, generation]);
  return active && settled === generation;
}
