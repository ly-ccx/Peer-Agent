import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { auxiliaryNavigator, RESOURCE_AUXILIARY_MIN_WIDTH, type ResourceNavigator } from './resourceNavigationState';
import type { WorkbenchTabId } from './workbenchTabState';

/** Changes geometry only; the existing file tree and Browser DOM never move or remount. */
export function useResourceNavigation(owner: string | undefined, tab: WorkbenchTabId, setTab: (tab: WorkbenchTabId) => void) {
  const ref = useRef<HTMLElement>(null), [width, setWidth] = useState(0);
  const [choice, setChoice] = useState<{ owner: string | undefined; mode: ResourceNavigator | null }>({ owner, mode: null });
  useLayoutEffect(() => setChoice({ owner, mode: null }), [owner]);
  const requested = choice.owner === owner ? choice.mode : null;
  const mode = owner ? auxiliaryNavigator(requested, tab, width) : null;
  useLayoutEffect(() => {
    const node = ref.current; if (!node) return;
    const measure = () => {
      const next = node.clientWidth;
      if (next < RESOURCE_AUXILIARY_MIN_WIDTH && node.contains(document.activeElement) && document.activeElement?.closest('.resource-aux-pane')) {
        node.querySelector<HTMLElement>('[data-navigator][aria-pressed="true"]')?.focus({ preventScroll: true });
      }
      setWidth(next);
    };
    measure(); const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node); window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const close = useCallback(() => {
    setChoice({ owner, mode: null });
    if (mode) ref.current?.querySelector<HTMLElement>(`[data-navigator="${mode}"]`)?.focus({ preventScroll: true });
  }, [owner, mode]);
  return { ref, mode, close, toggle: (next: ResourceNavigator) => {
    if (!owner) return;
    if (auxiliaryNavigator(next, tab, width)) setChoice({ owner, mode: requested === next ? null : next });
    else { setChoice({ owner, mode: null }); setTab(next); }
  } };
}
