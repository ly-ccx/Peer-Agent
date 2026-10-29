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
    // CSS owns the entrance. StrictMode may detach/reinstall this observer on
    // the same DOM node; cancelling its animation here would skip the entrance.
    const motion = watchVisualMotion(animations, () => setSettled(generation), { preserveAnimationOnCancel: true });
    return motion.cancel;
  }, [root, active, generation]);
  return active && settled === generation;
}
