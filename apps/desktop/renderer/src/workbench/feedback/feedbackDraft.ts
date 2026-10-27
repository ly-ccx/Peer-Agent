import { normalizeResourceFeedback, normalizeResourceFeedbackList, type ResourceFeedback } from '@peer-agent/protocol';
import { inputRecoveryFor } from '../../project-agent/state/useInputRecovery';

/** Adds recoverable user intent to the captured Bot. Never sends, switches Bot, or invokes a runner. */
export async function prepareResourceFeedbackDraft(raw: ResourceFeedback): Promise<{ readonly ok: boolean; readonly code?: string }> {
  const feedback = normalizeResourceFeedback(raw); if (!feedback) return { ok: false, code: 'INVALID_RESOURCE_FEEDBACK' };
  const session = inputRecoveryFor(feedback.recipient.workspaceId);
  if (!session.getSnapshot().ready && !await session.load()) return { ok: false, code: session.getSnapshot().error ?? 'DRAFT_UNAVAILABLE' };
  const current = session.getSnapshot().draft;
  const rows = normalizeResourceFeedbackList(current.resourceFeedback);
  if (!rows) return { ok: false, code: 'INVALID_RESOURCE_FEEDBACK' };
  const existing = rows.find(item => item.id === feedback.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(feedback)) return { ok: false, code: 'RESOURCE_FEEDBACK_ID_CONFLICT' };
  const next = existing ? rows : normalizeResourceFeedbackList([...rows, feedback]);
  if (!next) return { ok: false, code: 'RESOURCE_FEEDBACK_LIMIT' };
  if (next.some(row => row.recipient.workspaceId !== feedback.recipient.workspaceId)) return { ok: false, code: 'INVALID_RESOURCE_FEEDBACK' };
  if (!existing) session.edit({ resourceFeedback: next });
  return await session.flush() ? { ok: true } : { ok: false, code: session.getSnapshot().error ?? 'DRAFT_SAVE_FAILED' };
}
