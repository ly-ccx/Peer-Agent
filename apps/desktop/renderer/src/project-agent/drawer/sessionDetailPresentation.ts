import type { I18nRuntime } from '@peer-agent/i18n';
import { WORK_SESSION_STATUSES, type WorkSessionStatus } from '@peer-agent/protocol';
import { formatDrawerSessionStatus, formatDrawerStamp, type DrawerSession } from '../state/drawerState.ts';

const TONES: Record<WorkSessionStatus, 'attention' | 'active' | 'quiet'> = {
  waiting_user: 'attention', result_ready: 'attention',
  starting: 'active', running: 'active', verifying: 'active',
  queued: 'quiet', paused: 'quiet', accepted: 'quiet', failed: 'attention',
  cancelled: 'quiet', superseded: 'quiet',
};

/** The list owns live status; only the matching detail read carries the task report. */
export function selectSessionDetail(sessionId: string | null, selected: DrawerSession | null, detail: DrawerSession | null,
  available: boolean): DrawerSession | null {
  const live = selected?.sessionId === sessionId ? selected : null;
  const snapshot = detail?.sessionId === sessionId ? detail : null;
  const session = live ?? snapshot;
  if (!session) return null;
  return {
    ...session,
    summary: snapshot ? snapshot.summary : session.summary,
    evidenceRefs: snapshot ? snapshot.evidenceRefs : session.evidenceRefs,
    ...(!available ? { status: 'unavailable', statusLabel: '', progress: '' } : {}),
  };
}

/** Reports are content, never a substitute for the host's status or acceptance facts. */
export function sessionDetailPresentation(session: DrawerSession, i18n: Pick<I18nRuntime, 't'>, now = Date.now()) {
  const status = WORK_SESSION_STATUSES.find(value => value === session.status);
  const statusLabel = status
    ? status === 'starting' || status === 'queued' || status === 'paused'
      ? i18n.t(`projectAgent.drawer.taskDetail.status.${status}`)
      : i18n.t(`projectAgent.chat.sessionState.${status}`)
    : i18n.t('projectAgent.chat.work.unavailable');
  const recordedProgress = formatDrawerSessionStatus(session, i18n);
  const progress = status
    ? recordedProgress === status ? session.progress.trim() || statusLabel : recordedProgress || statusLabel
    : statusLabel;
  return {
    title: session.title && session.title !== session.sessionId
      ? session.title : i18n.t('projectAgent.drawer.taskDetail.untitled'),
    statusLabel,
    tone: status ? TONES[status] : 'quiet',
    progress,
    hint: i18n.t(status
      ? `projectAgent.drawer.taskDetail.hint.${status}`
      : 'projectAgent.drawer.taskDetail.hint.unavailable'),
    actionLabel: i18n.t(status === 'waiting_user'
      ? 'projectAgent.chat.work.handle'
      : status === 'result_ready'
        ? 'projectAgent.drawer.taskDetail.review'
        : 'projectAgent.drawer.taskDetail.open'),
    createdLabel: formatDrawerStamp(session.spawnedAt, now),
    report: session.summary.trim(),
    evidenceRefs: [...new Set(session.evidenceRefs.map(ref => ref.trim()).filter(Boolean))],
  };
}
