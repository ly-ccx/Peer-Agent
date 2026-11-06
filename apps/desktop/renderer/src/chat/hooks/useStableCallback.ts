import { useCallback, useLayoutEffect, useRef } from 'react';

/** Stable action identity with the latest committed closure. */
export function useStableCallback<T extends (...args: never[]) => unknown>(callback: T): T {
  const callbackRef = useRef(callback);
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return useCallback(((...args: Parameters<T>) => callbackRef.current(...args)) as T, []);
}
