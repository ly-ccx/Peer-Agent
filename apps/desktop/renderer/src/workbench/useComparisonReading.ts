import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import type { ResourceWindowNavigation } from '@peer-agent/protocol';

/** Selected-file coordinates are relative to the diff, independent of wrapper/header geometry. */
export function useComparisonReading({ identity, selected, ready, active, surface, body, initial, onRemember }: {
  readonly identity: string; readonly selected: string | null; readonly ready: boolean; readonly active: boolean;
  readonly surface: RefObject<HTMLElement | null>; readonly body: RefObject<HTMLDivElement | null>;
  readonly initial?: ResourceWindowNavigation; readonly onRemember?: (value: ResourceWindowNavigation) => void;
}) {
  const memory = useMemo(() => new Map((initial?.positions ?? []).map(point => [point.key, { top: point.top, left: point.left }])), [identity]);
  const pending = useRef<ResourceWindowNavigation | null>(null);
  const cycle = useMemo(() => ({ applied: '', interrupted: false }), [identity]);
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = selected === null ? 'all' : `file:${selected}`;
  const scroller = useCallback(() => surface.current?.closest<HTMLElement>('.resource-document-body, .resource-changes') ?? null, [surface]);
  const capture = useCallback((): ResourceWindowNavigation | undefined => {
    const scroll = scroller(), content = body.current;
    if (!ready || !active || currentIdentity.current !== identity || !scroll || !content) return;
    const point = { top: Math.max(0, scroll.getBoundingClientRect().top - content.getBoundingClientRect().top), left: scroll.scrollLeft };
    memory.delete(key); memory.set(key, point); while (memory.size > 12) memory.delete(memory.keys().next().value!);
    return { ...point, ...(selected !== null ? { selected } : {}), positions: [...memory].map(([key, point]) => ({ key, ...point })) };
  }, [identity, ready, active, scroller, body, memory, key, selected]);
  useLayoutEffect(() => {
    const scroll = scroller(), content = body.current, ticket = `${identity}:${key}`;
    if (!ready || !active || !scroll || !content || cycle.applied === ticket || cycle.interrupted) return;
    cycle.applied = ticket;
    const point = memory.get(key) ?? (initial?.selected === selected || selected === null && !initial?.selected ? initial : undefined);
    if (point) { scroll.scrollTop += content.getBoundingClientRect().top - scroll.getBoundingClientRect().top + point.top; scroll.scrollLeft = point.left; }
  }, [identity, key, ready, active, scroller, body, memory, initial, selected, cycle]);
  useEffect(() => {
    const scroll = scroller(); if (!scroll || !active) return;
    const remember = () => {
      const value = capture(); if (!value || !onRemember) return;
      pending.current = value;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = null; onRemember(value); }, 250);
    };
    const interrupt = () => { if (!ready) cycle.interrupted = true; };
    scroll.addEventListener('scroll', remember, { passive: true }); scroll.addEventListener('wheel', interrupt, { passive: true }); scroll.addEventListener('pointerdown', interrupt); scroll.addEventListener('keydown', interrupt);
    return () => {
      scroll.removeEventListener('scroll', remember); scroll.removeEventListener('wheel', interrupt); scroll.removeEventListener('pointerdown', interrupt); scroll.removeEventListener('keydown', interrupt);
      if (timer.current) { clearTimeout(timer.current); timer.current = null; const value = capture() ?? pending.current; if (value) onRemember?.(value); }
    };
  }, [scroller, capture, active, ready, onRemember, cycle]);
  return { capture };
}
