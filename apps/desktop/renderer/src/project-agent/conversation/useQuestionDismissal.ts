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
  const stopFocusTracking = useRef<() => void>(() => {});
  useLayoutEffect(() => () => stopFocusTracking.current(), []);
  const captureFocus = () => {
    stopFocusTracking.current();
    const node = ref.current;
    hadFocus.current = Boolean(node?.contains(document.activeElement));
    if (!node || !hadFocus.current) return;
    const interrupt = (event: Event) => {
      // A disabled button can release focus to body without user navigation.
      if (event.type === 'focusin' && event.target === document.body) return;
      if (!node.contains(event.target as Node)) { hadFocus.current = false; stopFocusTracking.current(); }
    };
    document.addEventListener('pointerdown', interrupt, true);
    document.addEventListener('focusin', interrupt, true);
    stopFocusTracking.current = () => {
      document.removeEventListener('pointerdown', interrupt, true);
      document.removeEventListener('focusin', interrupt, true);
      stopFocusTracking.current = () => {};
    };
  };
  if (resolved && present && ref.current?.contains(document.activeElement)) hadFocus.current = true;
  useLayoutEffect(() => {
    if (!resolved) { if (ref.current) ref.current.style.display = ''; hadFocus.current = false; settled.current = false; setPresent(true); return; }
    if (!present || settled.current) return;
    const node = ref.current;
    const returnFocus = node && hadFocus.current && !document.hidden
      && (typeof document.hasFocus !== 'function' || document.hasFocus())
      && (node.contains(document.activeElement) || document.activeElement === document.body);
    hadFocus.current = false; stopFocusTracking.current();
    if (node && returnFocus) {
      const destination = target.current?.(node);
      if (destination?.isConnected && !destination.closest('[inert]')) destination.focus({ preventScroll: true });
    }
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
  return { ref, present, captureFocus };
}
