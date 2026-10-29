import { useLayoutEffect, useRef, type RefObject } from 'react';
import { collectFocusable, focusBoundary } from './focusScope';
import { interactionLayers } from '../components/interactionLayers';
import { isImeKey } from '../../chat/state/compositionGuard';

/** Presentation only: enter once, optionally constrain Tab, and restore a live trigger. */
export function useFocusScope(root: RefObject<HTMLElement | null>, active: boolean, options: {
  trap?: boolean; restore?: RefObject<HTMLElement | null>; ownsScope?: () => boolean; restoreFocus?: boolean;
} = {}) {
  const latest = useRef(options); latest.current = options;
  useLayoutEffect(() => {
    const node = root.current;
    if (!active || !node) return;
    const previous = latest.current.restore?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const items = () => collectFocusable(node);
    const preferred = node.querySelector<HTMLElement>('[data-overlay-autofocus]');
    if (latest.current.ownsScope?.() !== false && !node.contains(document.activeElement)) {
      (preferred && !preferred.matches(':disabled') && !preferred.closest('[inert],[hidden]') && preferred.getClientRects().length ? preferred : items()[0] ?? node).focus({ preventScroll: true });
    }
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || isImeKey(event) || event.defaultPrevented || !latest.current.trap || latest.current.ownsScope?.() === false) return;
      const target = focusBoundary(items(), document.activeElement as HTMLElement | null, event.shiftKey);
      if (target) { event.preventDefault(); target.focus({ preventScroll: true }); }
      else if (!items().length) { event.preventDefault(); node.focus({ preventScroll: true }); }
    };
    const focus = (event: FocusEvent) => {
      if (!latest.current.trap || !node.isConnected) return;
      const layer = interactionLayers.layerFor(node);
      if (layer ? interactionLayers.modal() !== layer : latest.current.ownsScope?.() === false) return;
      if (event.target instanceof Node && (layer ? interactionLayers.contains(layer, event.target) : node.contains(event.target))) return;
      (items()[0] ?? node).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', focus);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', focus);
      if (latest.current.restoreFocus !== false && previous?.isConnected && !previous.closest('[inert]')
        && (node.contains(document.activeElement) || document.activeElement === document.body)) previous.focus({ preventScroll: true });
    };
  }, [root, active]);
}
