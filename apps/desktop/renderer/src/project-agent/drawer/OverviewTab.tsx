import type { BotProfile } from '@peer-agent/protocol';
import { BotAvatar } from '../BotAvatar';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import type { DrawerSession } from '../state/drawerState';

export function OverviewTab({
  path,
  pathExists,
  profile,
  sessionsAvailable,
  onOpenTasks,
  brief,
  running,
  modelLabel,
  mountedSkillCount = 0,
  mountedMcpCount = 0,
  onOpenCapabilities,
  i18n,
  onReveal,
  onRebind,
  rebinding = false,
  rebindFeedback = null,
  onOpenSession,
}: {
  readonly path: string;
  readonly pathExists?: boolean;
  readonly profile: BotProfile;
  readonly sessionsAvailable: boolean;
  readonly onOpenTasks: () => void;
  readonly brief: string;
  readonly running: readonly DrawerSession[];
  readonly modelLabel: string;
  readonly mountedSkillCount?: number;
  readonly mountedMcpCount?: number;
  readonly onOpenCapabilities?: () => void;
  readonly i18n: I18nRuntime;
  readonly onReveal: () => void;
  readonly onRebind?: () => void;
  readonly rebinding?: boolean;
  readonly rebindFeedback?: { readonly kind: 'error' | 'success'; readonly message: string } | null;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const trimmedPath = path.replace(/[\\/]+$/, '');
  const separator = Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\'));
  const folderName = trimmedPath.slice(separator + 1) || i18n.t('projectAgent.drawer.noPath');
  const parentPath = separator > 0 ? trimmedPath.slice(0, separator) : '';
  const folderMissing = Boolean(path) && pathExists === false;
  const needsBind = !path || folderMissing;

  return (
    <div className="bot-drawer-tab bot-overview-tab">
      <section className="bot-overview-identity">
        <BotAvatar avatar={profile.avatar} label={profile.displayName} workspaceId={profile.workspaceId} mood={running.length ? 'working' : 'idle'} />
        <div><h2>{profile.displayName}</h2><p>{brief || i18n.t('projectAgent.drawer.botDescription')}</p></div>
      </section>
      <section className="bot-overview-section">
        <h2>{i18n.t('projectAgent.drawer.folder')}</h2>
        <div className="bot-overview-folder" data-missing={folderMissing ? 'true' : undefined}>
          <div className="bot-overview-folder-main">
            <span className="bot-overview-folder-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3.5 7.5a2 2 0 0 1 2-2h4.1l2 2H18.5a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
              </svg>
            </span>
            <div className="bot-overview-folder-copy">
              <strong>{folderName}</strong>
              {parentPath && <p title={path}>{parentPath}</p>}
            </div>
          </div>
          {folderMissing ? (
            <p className="bot-overview-folder-missing" role="status">
              <PeerIcon name="warning" size={14} />
              <span>{i18n.t('projectAgent.drawer.folderMissing')}</span>
            </p>
          ) : null}
          <div className="bot-overview-folder-actions">
            <button type="button" disabled={!path || folderMissing || rebinding} onClick={onReveal}>
              {i18n.t('projectAgent.drawer.reveal')}
              <PeerIcon name="arrowUpRight" size={14} />
            </button>
            {onRebind ? (
              <button
                type="button"
                className={needsBind ? 'bot-overview-folder-rebind is-primary' : 'bot-overview-folder-rebind'}
                disabled={rebinding}
                onClick={onRebind}
              >
                {rebinding
                  ? i18n.t('projectAgent.drawer.rebinding')
                  : i18n.t(needsBind ? 'projectAgent.drawer.rebindFolder' : 'projectAgent.drawer.changeFolder')}
                <PeerIcon name="folder" size={14} />
              </button>
            ) : null}
          </div>
          {rebindFeedback ? (
            <p
              className={`bot-overview-folder-feedback is-${rebindFeedback.kind}`}
              role={rebindFeedback.kind === 'error' ? 'alert' : 'status'}
            >
              {rebindFeedback.message}
            </p>
          ) : null}
        </div>
      </section>
      <section className="bot-overview-section">
        <div className="bot-overview-heading">
          <h2>{i18n.t('projectAgent.drawer.running')}</h2>
          {running.length > 0 && <span>{running.length}</span>}
        </div>
        {!sessionsAvailable ? <p>{i18n.t('projectAgent.chat.work.unavailableHint')}</p> : running.length === 0 ? (
          <div className="bot-overview-idle">
            <span className="bot-overview-idle-dot" aria-hidden="true" />
            <p>{i18n.t('projectAgent.drawer.runningEmpty')}</p>
          </div>
        ) : (
          <ul className="bot-overview-sessions">
            {running.slice(0, 3).map((session) => (
              <li key={session.sessionId}>
                <button type="button" onClick={() => onOpenSession(session.sessionId)}>
                  <span>{session.title}</span>
                  <PeerIcon name="chevronRight" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {running.length > 3 ? <button type="button" onClick={onOpenTasks}>{i18n.t('projectAgent.chat.work.more', { count: running.length - 3 })}<PeerIcon name="chevronRight" size={14} /></button> : null}
      </section>
      <section className="bot-overview-details">
        <div><span>{i18n.t('projectAgent.drawer.settings.communicationStyle')}</span><strong>{i18n.t(`projectAgent.drawer.settings.communicationStyle.${profile.communicationStyle ?? 'inherit'}`)}</strong></div>
        <div><span>{i18n.t('projectAgent.drawer.settings.proactivity')}</span><strong>{i18n.t(`projectAgent.drawer.settings.proactivity.${profile.proactivity ?? 'inherit'}`)}</strong></div>
        <div>
          <span>{i18n.t('projectAgent.drawer.acceptance')}</span>
          <strong>{i18n.t(profile.acceptancePolicy === 'confirm' ? 'projectAgent.drawer.acceptance.confirm' : 'projectAgent.drawer.acceptance.auto')}</strong>
        </div>
        <div>
          <span>{i18n.t('projectAgent.drawer.model')}</span>
          <strong title={modelLabel}>{modelLabel || i18n.t('projectAgent.drawer.modelEmpty')}</strong>
        </div>
        <div>
          <span>{i18n.t('projectAgent.capabilities.overviewLabel')}</span>
          {onOpenCapabilities ? (
            <button type="button" className="bot-overview-cap-link" onClick={onOpenCapabilities}>
              <span>
                {mountedSkillCount > 0 || mountedMcpCount > 0
                  ? i18n.t('projectAgent.capabilities.overviewSummary', { skills: mountedSkillCount, mcps: mountedMcpCount })
                  : i18n.t('projectAgent.capabilities.overviewEmpty')}
              </span>
              <PeerIcon name="chevronRight" size={14} />
            </button>
          ) : (
            <strong>
              {mountedSkillCount > 0 || mountedMcpCount > 0
                ? i18n.t('projectAgent.capabilities.overviewSummary', { skills: mountedSkillCount, mcps: mountedMcpCount })
                : i18n.t('projectAgent.capabilities.overviewEmpty')}
            </strong>
          )}
        </div>
      </section>
    </div>
  );
}
