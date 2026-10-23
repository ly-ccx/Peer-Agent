import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from 'react';
import { isImeKey } from '../../chat/state/compositionGuard';
import { collectFocusable } from './focusScope';
import { interactionLayers, ownsLayerPointer, synchronizeModalBoundary, type InteractionLayer } from '../components/interactionLayers';

export const InteractionLayerContext = createContext<RefObject<InteractionLayer | null> | null>(null);

/** Shared dismissal/ownership for portals; changing data does not re-enter focus. */
export function useInteractionLayer(active: boolean, options: {
  roots: readonly RefObject<HTMLElement | null>[]; trigger?: RefObject<HTMLElement | null>;
  modal?: boolean; passive?: boolean; outside?: boolean; dismissOnTab?: boolean;
  restoreFocus?: boolean; closeOnTriggerRemoval?: boolean;
  onClose?: () => void; onEscape?: () => boolean; onEnter?: () => void;
}) {
  const parent = useContext(InteractionLayerContext), ownLayer = useRef<InteractionLayer | null>(null);
  const latest = useRef(options); latest.current = options;
  useLayoutEffect(() => {
    if (!active) return;
    const trigger = latest.current.trigger?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const context = trigger?.closest<HTMLElement>('main,[role=tabpanel],.bot-convo,.bot-list,.sidebar') ?? trigger?.parentElement;
    const neighbors = context ? collectFocusable(context) : [];
    const index = neighbors.indexOf(trigger!);
    const returnCandidates = [...neighbors.slice(index + 1), ...neighbors.slice(0, Math.max(0, index)).reverse()];
    const layer: InteractionLayer = { roots: () => latest.current.roots.flatMap(ref => ref.current ? [ref.current] : []), trigger, modal: latest.current.modal === true, passive: latest.current.passive, parent: () => parent?.current ?? null };
    ownLayer.current = layer;
    const originalRoots = layer.roots();
    const remove = interactionLayers.add(layer);
    synchronizeModalBoundary();
    let restore = true;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeKey(event)) return;
      if ((event.key === 'Tab' ? interactionLayers.topInteractive() : interactionLayers.top()) !== layer) return;
      if (event.key === 'Escape' && latest.current.onClose) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!latest.current.onEscape?.()) latest.current.onClose();
      } else if (event.key === 'Tab' && latest.current.dismissOnTab) {
        const own = layer.roots().flatMap(collectFocusable), active = own.indexOf(document.activeElement as HTMLElement);
        const within = own[active + (event.shiftKey ? -1 : 1)];
        if (within && (active >= 0 || !event.shiftKey)) {
          event.preventDefault(); within.focus({ preventScroll: true }); return;
        }
        const modal = interactionLayers.modal();
        const roots = modal ? modal.roots() : [document.body];
        const items = roots.flatMap(collectFocusable).filter(item => !interactionLayers.contains(layer, item));
        const index = items.indexOf(trigger!);
        const next = items[index + (event.shiftKey ? -1 : 1)] ?? (modal ? event.shiftKey ? items.at(-1) : items[0] : undefined);
        restore = false; latest.current.onClose?.();
        if (next) { event.preventDefault(); event.stopImmediatePropagation(); next.focus({ preventScroll: true }); }
      }
    };
    const outside = (event: PointerEvent) => {
      if (!latest.current.outside || !ownsLayerPointer(layer, event)) return;
      const target = event.target;
      if (target instanceof Node && !interactionLayers.contains(layer, target) && !trigger?.contains(target)) {
        restore = layer.modal; latest.current.onClose?.();
      }
    };
    window.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside, true);
    const anchorObserver = latest.current.closeOnTriggerRemoval && trigger && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => { if (!trigger.isConnected || trigger.closest('[inert],[hidden],[aria-hidden="true"]')) latest.current.onClose?.(); }) : null;
    anchorObserver?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'hidden', 'aria-hidden'] });
    const enterFrame = latest.current.onEnter ? requestAnimationFrame(() => {
      if (interactionLayers.topInteractive() === layer) latest.current.onEnter?.();
    }) : null;
    return () => {
      anchorObserver?.disconnect();
      if (enterFrame !== null) cancelAnimationFrame(enterFrame);
      window.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside, true);
      remove(); ownLayer.current = null; synchronizeModalBoundary();
      const active = document.activeElement;
      if (!restore || latest.current.restoreFocus === false || !(active === document.body || originalRoots.some(root => root.contains(active)))) return;
      const destination = latest.current.trigger?.current ?? trigger;
      if (destination?.isConnected && !destination.closest('[inert]')) destination.focus({ preventScroll: true });
      else {
        const parent = interactionLayers.modal()?.roots()[0];
        const neighbor = returnCandidates.find(item => item.isConnected && !item.closest('[inert],[hidden]'));
        (parent ? collectFocusable(parent)[0] ?? parent : neighbor)?.focus({ preventScroll: true });
      }
    };
  }, [active]);
  return ownLayer;
}
