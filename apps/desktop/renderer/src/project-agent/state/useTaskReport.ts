import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import { settleTaskReport, type TaskReportState } from './taskDetailState';
import type { DrawerSession } from './drawerState';

/** Scoped report reads never replace live status or another task's information. */
export function useTaskReport(workspaceId: string, sessionId: string | null, open: boolean,
  status: string | undefined, available: boolean, revision?: string, refreshIntervalMs?: number) {
  const [retry, setRetry] = useState(0);
  const [read, setRead] = useState<{ workspaceId: string; sessionId: string | null; detail: DrawerSession | null; state: TaskReportState } | null>(null);
  const matches = read?.workspaceId === workspaceId && read.sessionId === sessionId;
  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const matchingDetail = (previous: typeof read) => previous?.workspaceId === workspaceId && previous.sessionId === sessionId ? previous.detail : null;
    setRead(previous => ({ workspaceId, sessionId, detail: matchingDetail(previous), state: available ? 'loading' : 'unavailable' }));
    if (!available) return;
    const load = async () => {
      const result = await clientApi.projectAgentGetSession({ sessionId, detail: 'report' }).catch(() => null);
      if (cancelled) return;
      setRead(previous => ({ workspaceId, sessionId, ...settleTaskReport(sessionId, result, matchingDetail(previous)) }));
      if (refreshIntervalMs !== undefined) timer = setTimeout(() => void load(), refreshIntervalMs);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [workspaceId, sessionId, open, status, available, revision, retry, refreshIntervalMs]);
  return { detail: matches ? read.detail : null, state: matches ? read.state : 'loading' as TaskReportState,
    refresh: () => setRetry(value => value + 1) };
}
