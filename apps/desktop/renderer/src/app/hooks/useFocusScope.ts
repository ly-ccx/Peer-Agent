import { useLayoutEffect, useRef, type RefObject } from 'react';
import { focusBoundary } from './focusScope';
const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])';

/** Presentation only: enter once, optionally constrain Tab, and restore a live trigger. */
export function useFocusScope(root: RefObject<HTMLElement | null>, active: boolean, options: {
  trap?: boolean; restore?: RefObject<HTMLElement | null>; ownsScope?: () => boolean;
} = {}) {
  const latest = useRef(options); latest.current = options;
  useLayoutEffect(() => {
    const node = root.current;
    if (!active || !node) return;
    const previous = latest.current.restore?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const items = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(item => item.tabIndex >= 0 && item.getClientRects().length && !item.closest('[inert]'));
    (node.querySelector<HTMLElement>('[data-overlay-autofocus]') ?? items()[0] ?? node).focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.defaultPrevented || !latest.current.trap || latest.current.ownsScope?.() === false) return;
      const target = focusBoundary(items(), document.activeElement as HTMLElement | null, event.shiftKey);
      if (target) { event.preventDefault(); target.focus(); }
      else if (!items().length) { event.preventDefault(); node.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      if (previous?.isConnected && (node.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true });
    };
  }, [root, active]);
}
