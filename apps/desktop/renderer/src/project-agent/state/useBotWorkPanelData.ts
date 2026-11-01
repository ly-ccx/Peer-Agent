import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { createConversationRefresh } from './conversationRefresh';
import { reconcileFacts } from './reconcileFacts';

const EMPTY_ITEMS: readonly TaskOverviewItem[] = [];

/** Reuse the existing scoped task/artifact projection. Hidden panels defer reads; no polling. */
export function useBotWorkPanelData(workspaceId: string, workspacePath: string | null, enabled: boolean) {
  const [limit, setLimit] = useState(100);
  const [snapshot, setSnapshot] = useState<{ owner: string; items: readonly TaskOverviewItem[]; loadedLimit: number; loaded: boolean; loading: boolean; error: boolean }>({
    owner: '', items: [], loadedLimit: 0, loaded: false, loading: false, error: false,
  });
  const owner = JSON.stringify([workspaceId, workspacePath]);
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const refreshRef = useRef<ReturnType<typeof createConversationRefresh> | null>(null);
  useEffect(() => {
    if (!workspacePath) return;
    let disposed = false;
    const refresh = createConversationRefresh(async () => {
      setSnapshot(previous => previous.owner === owner ? { ...previous, loading: true }
        : { owner, items: [], loadedLimit: 0, loaded: false, loading: true, error: false });
      try {
        const items = await clientApi.taskOverviewList({ workspacePath, includeTerminal: true, activeWithinMs: 0, limit });
        if (!Array.isArray(items)) throw Error('Task projection unavailable');
        if (!disposed) setSnapshot(previous => ({ owner,
          items: reconcileFacts(previous.owner === owner ? previous.items : [], items, item => item.taskId),
          loadedLimit: limit, loaded: true, loading: false, error: false }));
      } catch {
        if (!disposed) setSnapshot(previous => previous.owner === owner ? { ...previous, loading: false, error: true }
          : { owner, items: [], loadedLimit: 0, loaded: false, loading: false, error: true });
      }
    }, { active: enabledRef.current });
    refreshRef.current = refresh;
    const offOverview = clientApi.onTaskOverviewChanged(() => { void refresh.request(); });
    void refresh.request();
    return () => { disposed = true; refresh.stop(); refreshRef.current = null; offOverview?.(); };
  }, [owner, workspaceId, workspacePath, limit]);
  useEffect(() => { void refreshRef.current?.setActive(enabled); }, [enabled]);
  const reload = useCallback(() => { void refreshRef.current?.request(); }, []);
  const current = snapshot.owner === owner;
  return { items: current ? snapshot.items : EMPTY_ITEMS, loaded: current && snapshot.loaded,
    loading: !!workspacePath && (!current || snapshot.loading), error: !workspacePath || current && snapshot.error,
    // The existing projection has no total/cursor. A short result cannot prove the archive is exhausted.
    windowLimit: current ? snapshot.loadedLimit : 0, reload, loadMore: () => setLimit(value => value + 100) };
}
