import { useCallback, useEffect, useMemo, useRef, type SyntheticEvent } from 'react';
import { threadScrollGesture } from '../state/threadScrollPolicy';
import { isImeKey } from '../state/compositionGuard';

/** The timeout expires a gesture marker; it never resumes follow or moves a viewport. */
export function useThreadScrollGesture(onIntent: (direction: 'up' | 'down' | 'unknown') => void) {
  const latest = useRef(onIntent); latest.current = onIntent;
  const current = useRef<{ active: boolean; direction: 'up' | 'down' | 'unknown' }>({ active: false, direction: 'unknown' });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = useCallback(() => { clearTimeout(timer.current); current.current.active = false; }, []);
  useEffect(() => clear, [clear]);
  const mark = useCallback((event: SyntheticEvent<HTMLElement>) => {
    const target = event.target;
    if (event.defaultPrevented || isImeKey(event.nativeEvent as KeyboardEvent)
      || target instanceof Element && target.closest('input,textarea,select,[contenteditable=true]')) return;
    if (event.type === 'pointerdown' && target !== event.currentTarget) return;
    const direction = threadScrollGesture(event.nativeEvent);
    if (!direction) return;
    clear(); current.current = { active: true, direction }; latest.current(direction);
    timer.current = setTimeout(() => { current.current.active = false; }, 120);
  }, [clear]);
  return useMemo(() => ({ state: current, mark, clear }), [mark, clear]);
}
