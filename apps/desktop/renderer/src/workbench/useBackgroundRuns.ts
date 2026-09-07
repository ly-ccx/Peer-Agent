import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagedShellTask } from '@peer-agent/protocol';
import { clientApi } from '../clientApi';

/** One polling reader shared by the footer status and its open panel. */
export function useBackgroundRuns() {
  const [snapshot, setSnapshot] = useState<readonly ManagedShellTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const reload = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const request = (async () => {
      try {
        const tasks = await clientApi.listShellTasks();
        if (mounted.current) { setSnapshot(tasks); setError(null); }
      } catch (err) {
        if (mounted.current) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    inFlight.current = request;
    void request.finally(() => { inFlight.current = null; });
    return request;
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    const timer = window.setInterval(() => void reload(), 2500);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [reload]);
  return { snapshot, error, reload };
}
