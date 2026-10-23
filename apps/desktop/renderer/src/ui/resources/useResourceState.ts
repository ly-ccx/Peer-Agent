import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createResourceActions, createResourceReader, IDLE_ACTION } from './resourceState';

export function useResourceRead<T>(identity: unknown, read: () => Promise<T>, enabled = true) {
  const ports = useMemo(() => ({ read }), [identity]); ports.read = read;
  const reader = useMemo(() => createResourceReader(() => ports.read()), [ports]);
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  useEffect(() => {
    if (enabled && !reader.snapshot().loaded && !reader.snapshot().error) void reader.reload();
    return () => reader.cancel();
  }, [reader, enabled]);
  return { ...state, reload: reader.reload, accept: reader.accept };
}

export function useResourceActions(identity: unknown) {
  const actions = useMemo(() => createResourceActions(), [identity]);
  const state = useSyncExternalStore(actions.subscribe, actions.snapshot, actions.snapshot);
  return { run: actions.run, get: (key: string) => state[key] ?? IDLE_ACTION };
}
