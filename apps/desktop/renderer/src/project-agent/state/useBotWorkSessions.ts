import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { createConversationRefresh } from './conversationRefresh';
import { indexBotWork } from './botWorkState';
import { readDrawerSession, type DrawerSession } from './drawerState';

/** Selected bot's existing host facts, shared by conversation and profile. No polling or execution. */
export function useBotWorkSessions(workspaceId: string | null) {
  const [snapshot, setSnapshot] = useState<{ workspaceId: string; sessions: readonly DrawerSession[]; available: boolean }>({ workspaceId: '', sessions: [], available: false });
  const requestRef = useRef<(() => Promise<void>) | null>(null);
  const reload = useCallback(() => requestRef.current?.() ?? Promise.resolve(), []);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const refresh = createConversationRefresh(async () => {
      try {
        const result = await clientApi.projectAgentListSessions({ workspaceId });
        if (cancelled) return;
        if (!result?.ok) throw Error('Session facts unavailable');
        setSnapshot({ workspaceId, sessions: (result.sessions ?? []).map(readDrawerSession).filter((session): session is DrawerSession => session !== null), available: true });
      } catch {
        if (!cancelled) setSnapshot(current => ({ workspaceId, sessions: current.workspaceId === workspaceId ? current.sessions : [], available: false }));
      }
    });
    requestRef.current = refresh.request;
    const changed = (event: { workspaceIds?: readonly string[] }) => {
      if (!event.workspaceIds?.length || event.workspaceIds.includes(workspaceId)) void refresh.request();
    };
    const offFacts = clientApi.onProjectAgentChanged(changed);
    const offMessages = clientApi.onProjectAgentConversationChanged(changed);
    void refresh.request();
    return () => { cancelled = true; requestRef.current = null; refresh.stop(); offFacts?.(); offMessages?.(); };
  }, [workspaceId]);
  const sessions = useMemo(() => snapshot.workspaceId === workspaceId ? snapshot.sessions : [], [snapshot, workspaceId]);
  const available = snapshot.workspaceId === workspaceId && snapshot.available;
  const index = useMemo(() => indexBotWork(sessions, available), [sessions, available]);
  return { sessions, available, index, reload };
}
