import { useEffect, useState } from 'react';
import type { ProjectObjectiveView } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

const EMPTY: readonly ProjectObjectiveView[] = [];

/** Read on open (and explicit retry), never in the background. Ignore a response after close or owner change. */
export function useBotWorkPanelObjectives(workspaceId: string, open: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{ owner: string; items: readonly ProjectObjectiveView[]; error: boolean }>();
  useEffect(() => {
    if (!open) { setSnapshot(undefined); return; }
    let disposed = false;
    setSnapshot(undefined);
    void (async () => {
      try {
        const result = await clientApi.projectObjectivesList({ workspaceId });
        if (!result.ok || !Array.isArray(result.items)) throw Error('Objective projection unavailable');
        if (!disposed) setSnapshot({ owner: workspaceId, items: result.items, error: false });
      } catch {
        if (!disposed) setSnapshot({ owner: workspaceId, items: EMPTY, error: true });
      }
    })();
    return () => { disposed = true; };
  }, [workspaceId, open, attempt]);
  const current = open && snapshot?.owner === workspaceId ? snapshot : undefined;
  return { items: current?.items ?? EMPTY, loading: open && !current, error: current?.error ?? false,
    reload: () => setAttempt(value => value + 1) };
}
