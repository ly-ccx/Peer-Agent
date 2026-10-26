import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

export function createDocumentReadingMemory() {
  const positions = new Map<string, { top: number; left: number }>();
  return {
    remember(mode: string, top: number, left: number) {
      if (Number.isFinite(top) && Number.isFinite(left)) positions.set(mode, { top: Math.max(0, top), left: Math.max(0, left) });
    },
    read(mode: string) { return { ...(positions.get(mode) ?? { top: 0, left: 0 }) }; },
  };
}

/** Per-document, per-mode reading geometry. No persisted execution or permission facts. */
export function useDocumentReadingPosition(identity: string, mode: string, active: boolean, ready: boolean,
  navigation?: { readonly line: number; readonly requestId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const memory = useMemo(createDocumentReadingMemory, [identity]);
  const applied = useRef('');
  const [lineResult, setLineResult] = useState<{ key: string; missing: boolean } | null>(null);
  const remember = useCallback(() => {
    if (active && ready && ref.current) memory.remember(mode, ref.current.scrollTop, ref.current.scrollLeft);
  }, [active, ready, memory, mode]);
  const restore = useCallback(() => {
    const node = ref.current;
    if (!node || !active || !ready) return;
    const requested = navigation ? `${identity}:${navigation.requestId}` : '';
    if (mode === 'source' && navigation && applied.current !== requested) {
      const target = node.querySelector<HTMLElement>(`[data-source-line="${navigation.line}"]`);
      applied.current = requested;
      setLineResult({ key: requested, missing: !target });
      if (target) {
        node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top;
        node.scrollLeft = 0;
        memory.remember(mode, node.scrollTop, node.scrollLeft);
        return;
      }
    }
    const point = memory.read(mode);
    node.scrollTop = point.top; node.scrollLeft = point.left;
  }, [active, ready, identity, memory, mode, navigation?.line, navigation?.requestId]);
  useLayoutEffect(restore, [restore]);
  return { ref, onScroll: remember, restore,
    missingLine: !!navigation && lineResult?.key === `${identity}:${navigation.requestId}` && lineResult.missing };
}
