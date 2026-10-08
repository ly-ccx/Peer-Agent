import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { settleTaskReport, type TaskReportState } from './taskDetailState';
import type { DrawerSession } from './drawerState';

/** Scoped report reads never replace live status or another task's information. */
export function useTaskReport(workspaceId: string, sessionId: string | null, open: boolean,
  status: string | undefined, available: boolean) {
  const [retry, setRetry] = useState(0);
  const [read, setRead] = useState<{ workspaceId: string; sessionId: string | null; detail: DrawerSession | null; state: TaskReportState } | null>(null);
  const matches = read?.workspaceId === workspaceId && read.sessionId === sessionId;
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    const matchingDetail = (previous: typeof read) => previous?.workspaceId === workspaceId && previous.sessionId === sessionId ? previous.detail : null;
    setRead(previous => ({ workspaceId, sessionId, detail: matchingDetail(previous), state: available ? 'loading' : 'unavailable' }));
    if (!available) return;
    const settle = (result: Parameters<typeof settleTaskReport>[1]) => {
      if (!cancelled) setRead(previous => ({ workspaceId, sessionId, ...settleTaskReport(sessionId, result, matchingDetail(previous)) }));
    };
    void clientApi.projectAgentGetSession({ sessionId, detail: 'report' }).then(settle).catch(() => settle(null));
    return () => { cancelled = true; };
  }, [workspaceId, sessionId, open, status, available, retry]);
  return { detail: matches ? read.detail : null, state: matches ? read.state : 'loading' as TaskReportState,
    refresh: () => setRetry(value => value + 1) };
}
