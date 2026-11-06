import { useCallback, useEffect, useRef, useState } from 'react';
import { watchVisualMotion } from '../state/visualMotion';
export { prefersReducedMotion } from '../state/motionEnvironment';

export interface MotionPresenceOptions {
  readonly onExitComplete: () => void;
  readonly exitDurationMs?: number;
}
export interface MotionPresenceApi {
  readonly exiting: boolean;
  readonly startExit: () => void;
  readonly cancelExit: () => void;
  readonly onAnimationEnd: (event?: { target: EventTarget | null; currentTarget: EventTarget | null }) => void;
}
/** One interruptible, presentation-only exit. Cancellation allows a kept-mounted surface to reopen. */
export function useMotionPresence({ onExitComplete, exitDurationMs = 240 }: MotionPresenceOptions): MotionPresenceApi {
  const [exiting, setExiting] = useState(false);
  const complete = useRef(onExitComplete); complete.current = onExitComplete;
  const motion = useRef<ReturnType<typeof watchVisualMotion> | null>(null);
  const active = useRef(false);
  const startExit = useCallback(() => { if (!active.current) { active.current = true; setExiting(true); } }, []);
  const cancelExit = useCallback(() => { active.current = false; motion.current?.cancel(); motion.current = null; setExiting(false); }, []);
  useEffect(() => {
    if (!exiting) return;
    motion.current = watchVisualMotion([], () => { if (active.current) { active.current = false; setExiting(false); complete.current(); } }, { durationMs: exitDurationMs });
    return () => { motion.current?.cancel(); motion.current = null; };
  }, [exiting, exitDurationMs]);
  const onAnimationEnd = useCallback((event?: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
    if (event && event.target !== event.currentTarget) return;
    if (active.current) motion.current?.finish();
  }, []);
  return { exiting, startExit, cancelExit, onAnimationEnd };
}
