import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { directoryRelative, type DirectoryReading } from './directorySessionState';

/** One restoration per mounted tree, after branches load. User input always wins. */
export function useDirectoryReadingPosition(ready: boolean, active: boolean, initial?: DirectoryReading,
  persistence?: { readonly root: string; readonly expanded: ReadonlySet<string>; readonly selected: string | null;
    readonly filter: string; readonly task?: DirectoryReading['task']; readonly remember?: (reading: DirectoryReading) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const restored = useRef(false), interrupted = useRef(false);
  const point = useRef({ top: initial?.top ?? 0, left: initial?.left ?? 0 });
  const interrupt = useCallback(() => {
    interrupted.current = true;
    if (ref.current) point.current = { top: ref.current.scrollTop, left: ref.current.scrollLeft };
  }, []);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !active || !ready || restored.current) return;
    restored.current = true;
    if (interrupted.current) return;
    node.scrollTop = point.current.top; node.scrollLeft = point.current.left;
  }, [ready, active]);
  const pending = useRef<DirectoryReading | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capture = useCallback((): DirectoryReading | undefined => {
    if (!ready || !persistence) return;
    const current = ref.current ? { top: ref.current.scrollTop, left: ref.current.scrollLeft } : point.current;
    return { root: persistence.root, ...(persistence.task ? { task: persistence.task } : {}), expanded: [...persistence.expanded]
      .map(path => directoryRelative(persistence.root, path)).filter((path): path is string => path !== null),
      selected: persistence.selected ? directoryRelative(persistence.root, persistence.selected) : null,
      filter: persistence.filter, ...current };
  }, [ready, persistence?.root, persistence?.expanded, persistence?.selected, persistence?.filter, persistence?.task?.sessionId, persistence?.task?.planId]);
  const remember = useCallback(() => {
    if (!ready || !persistence?.remember) return;
    pending.current = { root: persistence.root, ...(persistence.task ? { task: persistence.task } : {}), expanded: [...persistence.expanded]
      .map(path => directoryRelative(persistence.root, path)).filter((path): path is string => path !== null),
      selected: persistence.selected ? directoryRelative(persistence.root, persistence.selected) : null,
      filter: persistence.filter, ...point.current };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; if (pending.current) persistence.remember?.(pending.current); }, 250);
  }, [ready, persistence?.root, persistence?.expanded, persistence?.selected, persistence?.filter, persistence?.task?.sessionId, persistence?.task?.planId, persistence?.remember]);
  useEffect(remember, [remember]);
  useLayoutEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current) persistence?.remember?.(pending.current);
  }, [persistence?.remember]);
  return { ref, interrupt, capture, onScroll: useCallback(() => {
    if (!active || !ready || !ref.current) return;
    point.current = { top: ref.current.scrollTop, left: ref.current.scrollLeft };
    remember();
  }, [active, ready, remember]) };
}
