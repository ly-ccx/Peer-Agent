import { useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import type { WorkPanelGitStatus } from '../gitStatusTypes';

type GitStatus = Extract<WorkPanelGitStatus, { kind: 'status' }>;

export function useBotWorkPanelGitStatus(workspaceId: string, workspacePath: string | null, open: boolean, workRevision: string) {
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<{ owner: string; path: string | null; status?: GitStatus; loading: boolean; error?: boolean }>();
  useEffect(() => {
    if (!open || !workspaceId) { setView(undefined); return; }
    let disposed = false;
    const sameOwner = (previous: typeof view) => previous?.owner === workspaceId && previous.path === workspacePath;
    const update = (next: { status?: GitStatus; loading: boolean; error?: boolean }, retain = false) => {
      if (!disposed) setView(previous => ({ owner: workspaceId, path: workspacePath,
        status: retain && sameOwner(previous) ? previous?.status : undefined, ...next }));
    };
    update({ loading: true }, true);
    // Coalesce short bursts of session transitions; no polling while idle or closed.
    const timer = setTimeout(async () => {
      try {
        const result = await clientApi.projectAgentReadGitStatus({ workspaceId });
        if (result.kind === 'unavailable') update({ loading: false, error: true }, true);
        else update({ loading: false, status: result.kind === 'status' ? result : undefined });
      } catch { update({ loading: false, error: true }, true); }
    }, 120);
    return () => { disposed = true; clearTimeout(timer); };
  }, [workspaceId, workspacePath, open, workRevision, attempt]);
  const current = open && view?.owner === workspaceId && view.path === workspacePath ? view : undefined;
  return { status: current?.status, loading: current?.loading ?? false, error: current?.error ?? false,
    reload: () => setAttempt(value => value + 1) };
}
