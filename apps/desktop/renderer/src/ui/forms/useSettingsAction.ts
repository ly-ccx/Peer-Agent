import { useEffect, useRef, useState } from 'react';

/** Single pending settings write; retry always requires another explicit user action. */
export function useSettingsAction() {
  const live = useRef(true), lock = useRef(false), retry = useRef<(() => Promise<unknown>) | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [committed, setCommitted] = useState(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const run = async (write: () => Promise<unknown>) => {
    if (lock.current) return false;
    lock.current = true; retry.current = write;
    setBusy(true); setError(false); setCommitted(false);
    try {
      const receipt = await write();
      if (receipt === false) { retry.current = null; return false; }
      retry.current = null;
      if (live.current) setCommitted(true);
      return true;
    } catch { if (live.current) setError(true); return false; }
    finally { lock.current = false; if (live.current) setBusy(false); }
  };
  return { busy, error, committed, run, retry: () => retry.current ? run(retry.current) : Promise.resolve(false) };
}
