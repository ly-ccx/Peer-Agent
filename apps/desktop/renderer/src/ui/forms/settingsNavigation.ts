import { useCallback, useRef, useState, type SetStateAction } from 'react';

let owner: ((next: () => void) => boolean) | null = null;
let committing = false;
export function registerSettingsNavigation(request: (next: () => void) => boolean) {
  owner = request;
  return () => { if (owner === request) owner = null; };
}
export function commitSettingsNavigation(next: () => void) {
  const previous = committing; committing = true;
  try { next(); } finally { committing = previous; }
}
export function requestSettingsNavigation(next: () => void): boolean {
  if (!owner || committing) { next(); return true; }
  return owner(next);
}

/** Route intent waits for the active settings editor; no task/runtime navigation contract changes. */
export function useSettingsAwarePage<T extends string>(initial: T) {
  const [page, setPage] = useState<T>(initial), current = useRef(page);
  current.current = page;
  const change = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === 'function' ? action(current.current) : action;
    const commit = () => { current.current = next; setPage(next); };
    if (current.current === 'settings' && next !== 'settings') requestSettingsNavigation(commit);
    else commit();
  }, []);
  return [page, change] as const;
}
