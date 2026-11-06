import { useCallback, useEffect, useRef, useState } from 'react';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

/** A catalogue read failure preserves the last real list; it never becomes an empty success. */
export function useProviderCollection(onLoaded: (providers: readonly LlmProviderConfigView[]) => void) {
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const latest = useRef(onLoaded), rows = useRef(providers), live = useRef(true), order = useRef(0);
  latest.current = onLoaded; rows.current = providers;
  const refresh = useCallback(async () => {
    const ticket = ++order.current;
    if (live.current) { setLoading(true); setError(false); }
    try {
      const list = await clientApi.llmListProviderGroups();
      if (live.current && ticket === order.current) { setProviders(list); latest.current(list); }
      return list;
    } catch { if (live.current && ticket === order.current) setError(true); return rows.current; }
    finally { if (live.current && ticket === order.current) setLoading(false); }
  }, []);
  useEffect(() => { live.current = true; void refresh(); return () => { live.current = false; order.current++; }; }, [refresh]);
  return { providers, setProviders, loading, error, refresh };
}
