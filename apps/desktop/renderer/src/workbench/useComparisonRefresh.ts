import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createComparisonRefreshReader } from './comparisonRefreshState';

export function useComparisonRefresh(identity: string, read: Parameters<typeof createComparisonRefreshReader>[0], active: boolean) {
  const ports = useMemo(() => ({ read }), [identity]); ports.read = read;
  const reader = useMemo(() => createComparisonRefreshReader(() => ports.read()), [ports]);
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  useEffect(() => { if (active && !reader.snapshot().loaded) void reader.reload(); return () => reader.cancel(); }, [reader, active]);
  return { ...state, reload: reader.reload, observe: reader.observe, adopt: reader.adopt };
}
