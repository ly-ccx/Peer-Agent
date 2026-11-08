import { useCallback, useEffect, useState } from 'react';
import { clientApi } from '../../clientApi';
import type { ObligationGrantView } from '../conversation/ObligationGrantCard';

const POLL_MS = 15_000;

/** Pending grants for this bot. A main-process event refreshes immediately; the timer only covers a missed event. */
export function useObligationGrants(workspaceId: string, parentConversationId: string | undefined, onRefreshWork?: () => Promise<void>) {
  const [grants, setGrants] = useState<readonly ObligationGrantView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const load = useCallback(async () => {
    const list = clientApi.projectAgentListObligationGrants;
    if (typeof list !== 'function') return;
    try {
      const result = await list({ workspaceId, ...(parentConversationId ? { parentConversationId } : {}) });
      if (!result?.ok) {
        setError(result?.code || 'UNAVAILABLE');
        return;
      }
      setError(null);
      setGrants((result.grants || []).filter(grant => grant.status === 'pending').map(grant => ({
        grantId: grant.grantId, status: grant.status, items: grant.items || [],
      })));
    } catch {
      setError('UNAVAILABLE');
    }
  }, [workspaceId, parentConversationId]);
  useEffect(() => {
    void load();
    const off = typeof clientApi.onProjectAgentObligationGrants === 'function'
      ? clientApi.onProjectAgentObligationGrants(event => {
        if (!event?.workspaceId || event.workspaceId === workspaceId) void load();
      }) : undefined;
    const timer = window.setInterval(() => { void load(); }, POLL_MS);
    return () => { off?.(); window.clearInterval(timer); };
  }, [load, workspaceId]);
  const decide = useCallback(async (grantId: string, decision: 'confirm' | 'revoke') => {
    setSubmittingId(grantId);
    try {
      const result = await clientApi.projectAgentDecideObligation({
        workspaceId, grantId, decision, ...(parentConversationId ? { parentConversationId } : {}),
      });
      if (!result?.ok) {
        setError(result?.code || result?.error || 'UNAVAILABLE');
        return;
      }
      setError(null);
      await load();
      await onRefreshWork?.();
    } catch {
      setError('UNAVAILABLE');
    } finally {
      setSubmittingId(null);
    }
  }, [workspaceId, parentConversationId, load, onRefreshWork]);
  return {
    grants, error, submittingId, retry: () => { void load(); },
    confirm: (grantId: string) => { void decide(grantId, 'confirm'); },
    reject: (grantId: string) => { void decide(grantId, 'revoke'); },
  };
}
