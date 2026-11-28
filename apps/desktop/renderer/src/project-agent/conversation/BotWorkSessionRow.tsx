import type { I18nRuntime } from '@peer-agent/i18n';
import { WORK_SESSION_STATUSES, type TaskOverviewItem } from '@peer-agent/protocol';
import { PeerIcon } from '../../ui/icons';
import { ExecutorIcon, executorDisplayName } from '../ExecutorIcon';
import { formatDrawerSessionStatus, type DrawerSession } from '../state/drawerState';
import { workPanelNeedsUser, type WorkPanelLane } from '../state/botWorkPanelState';

export function BotWorkSessionRow({ session, overview, parent, question, variant, lane, i18n, onOpen }: {
  readonly session: DrawerSession;
  readonly overview?: TaskOverviewItem;
  readonly parent?: DrawerSession;
  readonly question?: string;
  readonly variant: 'task' | 'agent';
  readonly lane: WorkPanelLane;
  readonly i18n: I18nRuntime;
  readonly onOpen: (sessionId: string) => void;
}) {
  const needsUser = lane === 'needsYou' && (Boolean(question) || workPanelNeedsUser(session));
  const blocked = lane === 'needsYou' && !needsUser;
  const knownStatus = WORK_SESSION_STATUSES.find(value => value === session.status);
  const status = session.status === 'waiting_user' && session.followUp?.owner === 'bot' ? i18n.t('projectAgent.chat.work.waiting')
    : session.coordination?.phase === 'stopping' || ['stopping', 'awaiting_outcome'].includes(session.status)
    || session.status === 'result_ready' && !needsUser ? formatDrawerSessionStatus(session, i18n)
    : knownStatus ? i18n.t(`projectAgent.chat.sessionState.${knownStatus}`) : i18n.t('projectAgent.chat.work.unavailable');
  const title = session.title && session.title !== session.sessionId ? session.title : i18n.t('projectAgent.chat.work.related');
  const progress = overview?.planProgress;
  const knownProgress = progress && Number.isFinite(progress.total) && progress.total > 0
    && Number.isFinite(progress.completed) && progress.completed >= 0 && progress.completed <= progress.total ? progress : undefined;
  const statusDetail = formatDrawerSessionStatus(session, i18n);
  const detail = question || overview?.issueDetail || (session.status === 'verifying'
    ? session.verificationProgress ? i18n.t('projectAgent.chat.agent.verificationProgress', { count: session.verificationProgress.observationCount })
      : i18n.t('projectAgent.chat.work.verifyingHint')
    : lane === 'delivered' && session.summary ? session.summary
      : overview?.currentGoalTitle || (statusDetail === session.status ? status : statusDetail || status));
  const isZh = Boolean(i18n.locale?.startsWith('zh'));
  const progressLabel = knownProgress ? i18n.t('projectAgent.workPanel.progress', {
    completed: knownProgress.completed, total: knownProgress.total,
  }) : '';
  return <button type="button" className={`bot-work-panel-session is-${variant}`} data-needs-user={needsUser}
    data-blocked={blocked} data-session-id={session.sessionId}
    title={session.followUpEpoch ? (isZh ? `第 ${session.followUpEpoch} 轮跟进` : `Follow-up ${session.followUpEpoch}`) : undefined} onClick={() => onOpen(session.sessionId)}>
    <span className="bot-work-panel-agent-icon">
      <ExecutorIcon size={variant === 'agent' ? 14 : 16} title={executorDisplayName('peer', isZh)} />
    </span>
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
        {variant === 'agent' && parent ? <span>{i18n.t('projectAgent.workPanel.source', { name: parent.title })}</span> : null}
      </span>
    </span>
  </button>;
}
