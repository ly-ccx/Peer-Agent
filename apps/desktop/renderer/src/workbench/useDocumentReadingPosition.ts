import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DocumentReadPosition, DocumentReadPositions } from './documentSessionState';

export function createDocumentReadingMemory(initial?: DocumentReadPositions) {
  const positions = new Map<string, { top: number; left: number }>(Object.entries(initial ?? {}));
  return {
    remember(mode: string, top: number, left: number) {
      if (!Number.isFinite(top) || !Number.isFinite(left)) return;
      positions.delete(mode);
      positions.set(mode, { top: Math.min(10_000_000, Math.max(0, top)), left: Math.min(10_000_000, Math.max(0, left)) });
      while (positions.size > 12) positions.delete(positions.keys().next().value!);
    },
    read(mode: string) { return { ...(positions.get(mode) ?? { top: 0, left: 0 }) }; },
    snapshot() { return Object.fromEntries([...positions].map(([key, point]) => [key, { ...point }])); },
  };
}

/** Per-document, per-mode reading geometry. No persisted execution or permission facts. */
export function useDocumentReadingPosition(identity: string, mode: string, active: boolean, ready: boolean,
  navigation?: { readonly line: number; readonly requestId: string }, persistence?: {
    readonly key: string; readonly initial?: DocumentReadPositions;
    readonly onRemember?: (key: string, point: DocumentReadPosition) => void;
  }) {
  const ref = useRef<HTMLDivElement>(null);
  const memory = useMemo(() => createDocumentReadingMemory(persistence?.initial), [identity]);
  const key = persistence?.key ?? mode;
  const reading = useMemo(() => ({ moved: false }), [memory, key]);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applied = useRef('');
  const [lineResult, setLineResult] = useState<{ key: string; missing: boolean } | null>(null);
  const remember = useCallback(() => {
    if (active && ready && ref.current) {
      const { scrollTop, scrollLeft } = ref.current;
      const point = memory.read(key);
      if (scrollTop !== point.top || scrollLeft !== point.left) reading.moved = true;
      memory.remember(key, scrollTop, scrollLeft);
      if (persistence?.onRemember) {
        if (pending.current) clearTimeout(pending.current);
        pending.current = setTimeout(() => { pending.current = null; persistence.onRemember?.(key, memory.read(key)); }, 250);
      }
    }
  }, [active, ready, memory, key, reading, persistence?.onRemember]);
  useLayoutEffect(() => () => {
    if (pending.current) {
      clearTimeout(pending.current); pending.current = null;
      persistence?.onRemember?.(key, memory.read(key));
    }
  }, [memory, key, persistence?.onRemember]);
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
        memory.remember(key, node.scrollTop, node.scrollLeft);
        persistence?.onRemember?.(key, memory.read(key));
        return;
      }
    }
    const point = memory.read(key);
    node.scrollTop = point.top; node.scrollLeft = point.left;
  }, [active, ready, identity, memory, mode, key, navigation?.line, navigation?.requestId, persistence?.onRemember]);
  useLayoutEffect(restore, [restore]);
  const restoreUnvisited = useCallback((point: DocumentReadPosition) => {
    if (reading.moved) return;
    const node = ref.current, current = memory.read(key);
    // The browser may have scrolled before it dispatches the scroll event.
    if (active && ready && node && (node.scrollTop !== current.top || node.scrollLeft !== current.left)) return;
    memory.remember(key, point.top, point.left);
    restore();
  }, [active, ready, key, memory, reading, restore]);
  return { ref, onScroll: remember, restore, restoreUnvisited, snapshot: memory.snapshot,
    capture: () => { remember(); return memory.read(key); },
    missingLine: !!navigation && lineResult?.key === `${identity}:${navigation.requestId}` && lineResult.missing };
}
