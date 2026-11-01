import type { I18nRuntime } from '@peer-agent/i18n';
import { WORK_SESSION_STATUSES, type TaskOverviewItem } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { agentIdentity } from '../state/agentActivityState';
import { formatDrawerSessionStatus, type DrawerSession } from '../state/drawerState';
import { workPanelNeedsUser } from '../state/botWorkPanelState';

export function BotWorkSessionRow({ session, overview, parent, question, variant, i18n, onOpen }: {
  readonly session: DrawerSession;
  readonly overview?: TaskOverviewItem;
  readonly parent?: DrawerSession;
  readonly question?: string;
  readonly variant: 'task' | 'agent';
  readonly i18n: I18nRuntime;
  readonly onOpen: (sessionId: string) => void;
}) {
  const needsUser = workPanelNeedsUser(session);
  const blocked = needsUser || session.followUp?.reason === 'technical_block' || session.followUp?.reason === 'verification_failed';
  const knownStatus = WORK_SESSION_STATUSES.find(value => value === session.status);
  const status = session.coordination?.phase === 'stopping' || ['stopping', 'awaiting_outcome'].includes(session.status)
    || session.status === 'result_ready' && !needsUser ? formatDrawerSessionStatus(session, i18n)
    : knownStatus ? i18n.t(`projectAgent.chat.sessionState.${knownStatus}`) : i18n.t('projectAgent.chat.work.unavailable');
  const title = session.title && session.title !== session.sessionId ? session.title : i18n.t('projectAgent.chat.work.related');
  const progress = overview?.planProgress;
  const knownProgress = progress && Number.isFinite(progress.total) && progress.total > 0
    && Number.isFinite(progress.completed) && progress.completed >= 0 && progress.completed <= progress.total ? progress : undefined;
  const detail = question || overview?.issueDetail || (session.status === 'verifying'
    ? session.verificationProgress ? i18n.t('projectAgent.chat.agent.verificationProgress', { count: session.verificationProgress.observationCount })
      : i18n.t('projectAgent.chat.work.verifyingHint')
    : overview?.currentGoalTitle || formatDrawerSessionStatus(session, i18n) || status);
  const identity = agentIdentity(session.sessionId);
  const progressLabel = knownProgress ? i18n.t('projectAgent.workPanel.progress', {
    completed: knownProgress.completed, total: knownProgress.total,
  }) : '';
  return <button type="button" className={`bot-work-panel-session is-${variant}`} data-needs-user={needsUser}
    data-blocked={blocked} data-session-id={session.sessionId} onClick={() => onOpen(session.sessionId)}>
    {variant === 'agent' ? <span className="bot-work-panel-agent-icon"><PeerIcon name={identity.icon} size={17} /></span> : null}
    <span className="bot-work-panel-session-copy">
      <span className="bot-work-panel-session-heading"><strong>{title}</strong>
        <span className="bot-work-panel-status"><PeerIcon name={needsUser ? 'info' : blocked ? 'warning' : 'circle'} size={11} />
          {needsUser ? i18n.t('projectAgent.workPanel.needsYou') : status}</span></span>
      {knownProgress && variant === 'task' ? <span className="bot-work-panel-progress" role="progressbar"
        aria-label={progressLabel} aria-valuemin={0}
        aria-valuenow={knownProgress.completed} aria-valuemax={knownProgress.total}>
        <span style={{ width: `${knownProgress.completed / knownProgress.total * 100}%` }} />
      </span> : null}
      <span className="bot-work-panel-session-detail">{detail}</span>
      <span className="bot-work-panel-session-meta">
        {knownProgress ? <span>{progressLabel}</span> : null}
        {variant === 'agent' && session.modelLabel ? <span>{session.modelLabel}</span> : null}
        {variant === 'agent' && parent ? <span>{i18n.t('projectAgent.workPanel.source', { name: parent.title })}</span> : null}
      </span>
    </span>
  </button>;
}
