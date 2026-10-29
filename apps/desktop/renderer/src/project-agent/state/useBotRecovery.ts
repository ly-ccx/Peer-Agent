import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectRecoveryRequest, ProjectRecoveryView } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';

const activePhase = (view: ProjectRecoveryView) => ['stopping', 'backing_up', 'restoring', 'reconciling'].includes(view.phase);
/** Keeps progress scoped to the initiating bot; notifications never submit chat inputs. */
export function useBotRecovery(workspaceId: string) {
  const [view, setView] = useState<ProjectRecoveryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const generation = useRef(0), reads = useRef(0), mutating = useRef(false), watching = useRef(false);
  const inspect = useCallback(async () => {
    const ticket = generation.current, read = ++reads.current;
    if (!mutating.current) setBusy(true);
    try {
      const result = await clientApi.projectAgentRecovery({ workspaceId, action: 'inspect' });
      if (ticket !== generation.current || read !== reads.current) return;
      if (result.ok) {
        if (!mutating.current || activePhase(result.view)) setView(result.view);
        setError(null);
        if (result.view.phase !== 'occupied') {
          setHandoff(false);
          if (!mutating.current && (!result.view.canContinue || result.view.runtimeReady)) watching.current = false;
        }
      } else setError(result.code);
    } catch { if (ticket === generation.current) setError('RECOVERY_UNAVAILABLE'); }
    finally { if (ticket === generation.current && read === reads.current && !mutating.current) setBusy(false); }
  }, [workspaceId]);
  useEffect(() => {
    generation.current++; reads.current++; mutating.current = false; watching.current = false;
    setView(null); setError(null); setBusy(false); setHandoff(false);
    const off = clientApi.onProjectAgentChanged(event => {
      if (watching.current && (!event.workspaceIds?.length || event.workspaceIds.includes(workspaceId))) void inspect();
    });
    return () => { generation.current++; reads.current++; off(); };
  }, [workspaceId, inspect]);
  const check = useCallback(() => { watching.current = true; void inspect(); }, [inspect]);
  const execute = useCallback(async (action: Exclude<ProjectRecoveryRequest['action'], 'inspect'>, target?: Pick<ProjectRecoveryRequest, 'workId' | 'sessionId'>) => {
    if (!view?.planToken || mutating.current) return;
    const ticket = generation.current;
    mutating.current = true; watching.current = true; setBusy(true); setError(null);
    try {
      const result = await clientApi.projectAgentRecovery({ workspaceId, action, planToken: view.planToken, ...target });
      if (ticket !== generation.current) return;
      reads.current++;
      watching.current = result.ok && result.view.canContinue && !result.view.runtimeReady;
      if (result.ok) setView(result.view); else { setError(result.code); setView(current => current ? { ...current, phase: 'failed' } : current); }
    } catch { if (ticket === generation.current) { watching.current = false; setError('RECOVERY_UNAVAILABLE'); } }
    finally { if (ticket === generation.current) {
      mutating.current = false; setBusy(false);
      // A ready notification can race the command receipt and be discarded by
      // its read fence. Recheck once after publication, then follow host events.
      if (watching.current) void inspect();
    } }
  }, [workspaceId, view?.planToken, inspect]);
  const takeover = useCallback(async () => {
    if (mutating.current) return;
    const ticket = generation.current;
    setBusy(true); setError(null); watching.current = true;
    try {
      const result = await clientApi.projectAgentTakeoverHost({ workspaceId });
      if (ticket !== generation.current) return;
      if (!result.ok) setError(result.code);
      else { setHandoff(result.requested); await inspect(); }
    } catch { if (ticket === generation.current) setError('HOST_UNAVAILABLE'); }
    finally { if (ticket === generation.current) setBusy(false); }
  }, [workspaceId, inspect]);
  return { view, error, busy: busy || Boolean(view && activePhase(view)), handoff, check, execute, takeover };
}
