import { useEffect, useRef, type RefObject } from 'react';
import { useFocusScope } from '../../app/hooks/useFocusScope';
import { interactionLayers } from '../../app/components/interactionLayers';
import { isImeKey } from '../../chat/state/compositionGuard';

/** A dock is a peer reading surface, so Tab can move between it and the resource pane. */
export function useBotDrawerFocus(active: boolean, body: RefObject<HTMLElement | null>, trigger: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose); close.current = onClose;
  useFocusScope(body, active, { trap: false, restore: trigger, ownsScope: () => !interactionLayers.topInteractive() });
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeKey(event) || interactionLayers.topInteractive()) return;
      if (!(event.target instanceof Node) || !body.current?.contains(event.target)) return;
      event.preventDefault(); close.current();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [active, body]);
}
