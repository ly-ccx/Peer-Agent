import { useEffect } from 'react';
import { normalizeResourceFeedback } from '@peer-agent/protocol';
import { prepareResourceFeedbackDraft } from './feedbackDraft';
/** MainApp only. A cross-window request prepares the captured Bot's draft, never sends or navigates. */
export function useResourceFeedbackPreparations() {
  useEffect(() => {
    const api = window.peerAgent;
    if (!api?.onResourceFeedbackPreparation || !api.claimResourceFeedbackPreparation || !api.acknowledgeResourceFeedbackPreparation) return;
    let active = true;
    const jobs = new Set<string>();
    const stop = api.onResourceFeedbackPreparation(request => {
      if (!active || jobs.has(request?.requestId) || !request?.requestId || !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) return;
      const row = normalizeResourceFeedback(request.feedback); if (!row) return;
      const key = { requestId: request.requestId, identity: request.identity, feedbackId: row.id };
      if (jobs.size >= 16) { void api.acknowledgeResourceFeedbackPreparation!({ ...key, ok: false, code: 'DRAFT_BUSY' }).catch(() => {}); return; }
      jobs.add(request.requestId);
      void (async () => {
        let result: { ok: boolean; code?: string };
        try {
          const claimed = await api.claimResourceFeedbackPreparation!(key);
          result = claimed.ok ? active && request.expiresAt > Date.now() ? await prepareResourceFeedbackDraft(row) : { ok: false, code: 'PREPARATION_EXPIRED' } : claimed;
        } catch { result = { ok: false, code: 'DRAFT_SAVE_FAILED' }; }
        try { if (active) await api.acknowledgeResourceFeedbackPreparation!({ ...key, ...result }); } catch { /* An absent receipt never creates a send or retry. */ }
        jobs.delete(request.requestId);
      })();
    });
    return () => { active = false; stop(); };
  }, []);
}
