import { useLayoutEffect, useMemo, useState } from 'react';
import { createForegroundRefreshLoop } from './foregroundRefreshState';

/** Opt-in foreground polling; it never replaces scoped reads with an unscoped watch. */
export function useForegroundRefresh(identity: string, active: boolean, check: () => Promise<unknown>) {
  const [choice, setChoice] = useState({ identity, enabled: false });
  useLayoutEffect(() => setChoice({ identity, enabled: false }), [identity]);
  const enabled = choice.identity === identity && choice.enabled;
  // A retiring owner's timer must never acquire the new owner's reader.
  const ports = useMemo(() => ({ check }), [identity]); ports.check = check;
  useLayoutEffect(() => {
    if (!enabled || !active) return;
    const loop = createForegroundRefreshLoop({ check: () => ports.check(),
      foreground: () => document.visibilityState === 'visible' && document.hasFocus(),
      schedule: (callback, delay) => window.setTimeout(callback, delay), cancel: timer => window.clearTimeout(timer as number) });
    loop.start(); document.addEventListener('visibilitychange', loop.wake); window.addEventListener('focus', loop.wake); window.addEventListener('blur', loop.wake);
    return () => { loop.stop(); document.removeEventListener('visibilitychange', loop.wake); window.removeEventListener('focus', loop.wake); window.removeEventListener('blur', loop.wake); };
  }, [ports, active, enabled]);
  return { enabled, toggle: () => setChoice({ identity, enabled: !enabled }) };
}
