import { useLayoutEffect, useRef, useState } from 'react';
import { animateVisual, motionDurationMs } from '../../app/state/visualMotion';

/** Resolved facts own removal; motion only closes the footprint and hands off existing focus. */
export function useQuestionDismissal(resolved: boolean, onClosed?: () => void,
  focusTarget?: (node: HTMLElement) => HTMLElement | null) {
  const ref = useRef<HTMLElement>(null);
  const [present, setPresent] = useState(!resolved);
  const closed = useRef(onClosed); closed.current = onClosed;
  const target = useRef(focusTarget); target.current = focusTarget;
  const hadFocus = useRef(false), settled = useRef(false);
  if (resolved && present && ref.current?.contains(document.activeElement)) hadFocus.current = true;
  useLayoutEffect(() => {
    if (!resolved) { if (ref.current) ref.current.style.display = ''; hadFocus.current = false; settled.current = false; setPresent(true); return; }
    if (!present || settled.current) return;
    const node = ref.current;
    if (node && hadFocus.current && (node.contains(document.activeElement) || document.activeElement === document.body)) {
      const destination = target.current?.(node);
      if (destination?.isConnected && !destination.closest('[inert]')) destination.focus({ preventScroll: true });
    }
    hadFocus.current = false;
    const finish = () => {
      if (settled.current) return;
      settled.current = true;
      // WAAPI cancellation removes its fill before React commits removal.
      if (node) node.style.display = 'none';
      setPresent(false); closed.current?.();
    };
    if (!node) { finish(); return; }
    let motion: ReturnType<typeof animateVisual>;
    try {
      const style = getComputedStyle(node);
      motion = animateVisual(node, [
        { height: `${node.getBoundingClientRect().height}px`, opacity: 1, marginTop: style.marginTop, paddingTop: style.paddingTop },
        { height: '0px', opacity: 0, marginTop: '0px', paddingTop: '0px', borderTopWidth: '0px' },
      ], { duration: motionDurationMs(style.getPropertyValue('--za-motion-medium')),
        easing: style.getPropertyValue('--za-ease-standard').trim() || 'ease', fill: 'forwards' }, finish);
    } catch { finish(); return; }
    return motion.cancel;
  }, [resolved, present]);
  return { ref, present };
}
