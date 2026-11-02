import type { DrawerSession } from './drawerState';
import { formatDrawerSessionStatus, readDrawerSession } from './drawerState.ts';
import { WORK_SESSION_STATUSES } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { TaskConversationContext } from './taskConversationState';

export type TaskReportState = 'loading' | 'ready' | 'unavailable';

/** Failed refreshes retain a matching report; deletion and foreign IDs cannot supply it. */
export function settleTaskReport(sessionId: string, result: { ok?: boolean; session?: unknown; code?: string } | null,
  previous: DrawerSession | null): { detail: DrawerSession | null; state: TaskReportState } {
  const detail = result?.ok ? readDrawerSession(result.session) : null;
  if (detail?.sessionId === sessionId) return { detail, state: 'ready' };
  return { detail: result?.code === 'NOT_FOUND' ? null : previous?.sessionId === sessionId ? previous : null, state: 'unavailable' };
}

/** Live list facts own status; the matching detail supplies the report omitted by lists. */
export function mergeTaskDetail(selected: DrawerSession | null, detail: DrawerSession | null): DrawerSession | null {
  if (!selected) return detail;
  if (!detail || detail.sessionId !== selected.sessionId) return selected;
  const current = (!selected.sourceRevision || selected.sourceRevision === detail.sourceRevision)
    && (!selected.observationRevision || selected.observationRevision === detail.observationRevision);
  return { ...detail, ...selected, summary: detail.summary, evidenceRefs: detail.evidenceRefs,
    verification: current ? detail.verification : undefined };
}

/** Current host blockers outrank a historical bot note; task instructions are never progress. */
export function taskProgressPreview(session: DrawerSession, context: TaskConversationContext | null, i18n: I18nRuntime): string {
  const current = formatDrawerSessionStatus(session, i18n);
  if (session.resourceBlocker || session.queuedBehind?.length || session.queueReason
    || session.coordination?.phase === 'stopping'
    || ['queued', 'starting', 'stopping', 'awaiting_outcome', 'cancelled', 'accepted', 'failed', 'unavailable'].includes(session.status)) return current;
  if (session.status === 'verifying' && session.verificationProgress) return i18n.t('projectAgent.chat.agent.verificationProgress', {
    count: session.verificationProgress.observationCount,
  });
  const status = WORK_SESSION_STATUSES.find(value => value === session.status);
  if (status && session.statusLabel && session.statusLabel !== i18n.t(`projectAgent.chat.sessionState.${status}`)) return current;
  const related = context?.sessionId === session.sessionId ? context : null;
  const needsYou = session.followUp ? session.followUp.owner === 'user' : session.status === 'waiting_user' || session.status === 'result_ready';
  const note = needsYou ? related?.question?.content : related?.content;
  const text = note?.replace(/\s+/g, ' ').trim();
  if (text) {
    const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    return needsYou ? preview : i18n.t('projectAgent.drawer.task.progressNote', { content: preview });
  }
  if (needsYou || session.status === 'verifying' || session.status === 'result_ready') return current;
  return i18n.t('projectAgent.drawer.task.progressPending');
}
