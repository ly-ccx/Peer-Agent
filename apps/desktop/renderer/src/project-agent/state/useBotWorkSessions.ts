import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { createConversationRefresh } from './conversationRefresh';
import { indexBotWork } from './botWorkState';
import { reconcileFacts } from './reconcileFacts';
import { readDrawerSession, type DrawerSession } from './drawerState';

/** Selected bot's existing host facts, shared by conversation and profile. No polling or execution. */
export function useBotWorkSessions(workspaceId: string | null, active = true) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const refreshRef = useRef<ReturnType<typeof createConversationRefresh> | null>(null);
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
        const sessions = (result.sessions ?? []).map(readDrawerSession).filter((session): session is DrawerSession => session !== null);
        setSnapshot(current => {
          const next = reconcileFacts(current.workspaceId === workspaceId ? current.sessions : [], sessions, row => row.sessionId);
          return current.workspaceId === workspaceId && current.available && next === current.sessions
            ? current : { workspaceId, sessions: next, available: true };
        });
      } catch {
        if (!cancelled) setSnapshot(current => ({ workspaceId, sessions: current.workspaceId === workspaceId ? current.sessions : [], available: false }));
      }
    }, { active: activeRef.current });
    refreshRef.current = refresh;
    requestRef.current = refresh.request;
    const changed = (event: { workspaceIds?: readonly string[] }) => {
      if (!event.workspaceIds?.length || event.workspaceIds.includes(workspaceId)) void refresh.request();
    };
    const offFacts = clientApi.onProjectAgentChanged(changed);
    const offMessages = clientApi.onProjectAgentConversationChanged(changed);
    void refresh.request();
    return () => { cancelled = true; requestRef.current = null; refreshRef.current = null; refresh.stop(); offFacts?.(); offMessages?.(); };
  }, [workspaceId]);
  useEffect(() => { refreshRef.current?.setActive(active); }, [active]);
  const sessions = useMemo(() => snapshot.workspaceId === workspaceId ? snapshot.sessions : [], [snapshot, workspaceId]);
  const available = snapshot.workspaceId === workspaceId && snapshot.available;
  const index = useMemo(() => indexBotWork(sessions, available), [sessions, available]);
  return { sessions, available, index, reload };
}
