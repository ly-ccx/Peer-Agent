import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { clientApi } from '../../clientApi';
import { conversationStore } from '../state/conversationStore';
import { hasSidebarInterruption, sidebarInterruptedState } from '../state/sidebarInterruptedState';

/** Leaf subscription: token updates do not rerender the whole sidebar. */
export function useSidebarInterruption(id: string, updatedAt: string | null | undefined, isRunning: boolean): boolean {
  const [persisted, setPersisted] = useState(false);
  const subscribe = useCallback((notify: () => void) => conversationStore.subscribe(id, notify), [id]);
  const snapshot = useCallback(() => sidebarInterruptedState(
    conversationStore.getSnapshot(id), persisted, isRunning,
  ), [id, persisted, isRunning]);
  const interrupted = useSyncExternalStore(subscribe, snapshot);

  useEffect(() => {
    let cancelled = false;
    setPersisted(false);
    const state = conversationStore.getSnapshot(id);
    if (!isRunning && state.loadStatus !== 'ready' && state.messages.length === 0) {
      void clientApi.conversationsGet({ id }).then((conversation) => {
        if (!cancelled) setPersisted(hasSidebarInterruption(conversation?.messages ?? []));
      }).catch(() => { /* Unknown history is not evidence of interruption. */ });
    }
    return () => { cancelled = true; };
  }, [id, updatedAt, isRunning]);

  return interrupted;
}
