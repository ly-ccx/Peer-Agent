import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { motionDurationMs, watchVisualMotion } from '../state/visualMotion';

/** Native disclosure semantics, shared motion, and overflow released after opening. */
export const MotionDetails = forwardRef<HTMLDetailsElement, ComponentPropsWithoutRef<'details'>>(function MotionDetails(
  { children, className, onToggle, ...props }, forwardedRef,
) {
  const root = useRef<HTMLDetailsElement | null>(null);
  const motion = useRef<ReturnType<typeof watchVisualMotion> | null>(null);
  const [settled, setSettled] = useState(props.open === true);
  const ref = useCallback((node: HTMLDetailsElement | null) => {
    root.current = node;
    if (typeof forwardedRef === 'function') {
      // ForwardedRef still types callbacks as void; React may return a ref cleanup.
      const cleanup: unknown = forwardedRef(node);
      if (typeof cleanup === 'function') return () => { root.current = null; cleanup(); };
    } else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);
  useEffect(() => () => motion.current?.cancel(), []);
  return <details {...props} ref={ref} className={`${className ?? ''} motion-details`} data-motion-settled={settled}
    onToggle={event => {
      if (event.target !== event.currentTarget) { onToggle?.(event); return; }
      motion.current?.cancel();
      const node = event.currentTarget;
      setSettled(false);
      let duration = 0;
      let animations: Animation[] = [];
      try {
        if (typeof CSS !== 'undefined' && CSS.supports('interpolate-size: allow-keywords') && CSS.supports('selector(details::details-content)')) {
          duration = motionDurationMs(getComputedStyle(node).getPropertyValue('--za-motion-medium'));
          animations = node.getAnimations?.() ?? [];
        }
      } catch { /* Native static disclosure remains usable. */ }
      motion.current = watchVisualMotion(animations, () => { if (node.isConnected) setSettled(node.open); }, { durationMs: duration });
      onToggle?.(event);
    }}>{children}</details>;
});
