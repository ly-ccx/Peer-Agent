import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createEditableResource } from './editableResource';

type Ports<T> = Parameters<typeof createEditableResource<T>>[1];
type Entry<T> = { resource: ReturnType<typeof createEditableResource<T>>; ports: Ports<T>; users: number };
// Dirty presentation drafts only; never credentials, permission truth or durable storage.
const drafts = new Map<string, Entry<unknown>>();

export function useEditableResource<T>(key: string, initial: T, ports: Ports<T>, retain = true) {
  const ref = useRef<{ key: string; entry: Entry<T> } | null>(null);
  if (ref.current?.key !== key) {
    let entry = retain ? drafts.get(key) as Entry<T> | undefined : undefined;
    if (!entry) {
      const next: Entry<T> = { ports, users: 0, resource: null! };
      next.resource = createEditableResource(initial, {
        read: () => next.ports.read(), write: (draft, saved) => next.ports.write(draft, saved), equal: ports.equal,
      });
      entry = next;
      if (retain) drafts.set(key, entry as Entry<unknown>);
    }
    ref.current = { key, entry };
  }
  const { entry } = ref.current;
  entry.ports = ports;
  const resource = entry.resource;
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot);
  useEffect(() => {
    entry.users++;
    if (retain) drafts.set(key, entry as Entry<unknown>);
    void resource.load();
    return () => {
      entry.users--;
      if (entry.users === 0 && !resource.snapshot().dirty && !resource.snapshot().saving && drafts.get(key) === entry) drafts.delete(key);
    };
  }, [key, entry, resource, retain]);
  return { ...state, edit: resource.edit, reset: resource.reset, reload: resource.load, save: resource.save };
}
