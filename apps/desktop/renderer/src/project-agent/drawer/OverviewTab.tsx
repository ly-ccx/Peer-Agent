import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import type { DrawerSession } from '../state/drawerState';

export function OverviewTab({
  path,
  brief,
  running,
  modelLabel,
  i18n,
  onReveal,
  onOpenSession,
}: {
  readonly path: string;
  readonly brief: string;
  readonly running: readonly DrawerSession[];
  readonly modelLabel: string;
  readonly i18n: I18nRuntime;
  readonly onReveal: () => void;
  readonly onOpenSession: (sessionId: string) => void;
}) {
  const trimmedPath = path.replace(/[\\/]+$/, '');
  const separator = Math.max(trimmedPath.lastIndexOf('/'), trimmedPath.lastIndexOf('\\'));
  const folderName = trimmedPath.slice(separator + 1) || i18n.t('projectAgent.drawer.noPath');
  const parentPath = separator > 0 ? trimmedPath.slice(0, separator) : '';

  return (
    <div className="bot-drawer-tab bot-overview-tab">
      <section className="bot-overview-section">
        <h2>{i18n.t('projectAgent.drawer.folder')}</h2>
        <div className="bot-overview-folder">
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
          <button type="button" disabled={!path} onClick={onReveal}>
            {i18n.t('projectAgent.drawer.reveal')}
            <PeerIcon name="arrowUpRight" size={14} />
          </button>
        </div>
      </section>
      <section className="bot-overview-section">
        <div className="bot-overview-heading">
          <h2>{i18n.t('projectAgent.drawer.running')}</h2>
          {running.length > 0 && <span>{running.length}</span>}
        </div>
        {running.length === 0 ? (
          <div className="bot-overview-idle">
            <span className="bot-overview-idle-dot" aria-hidden="true" />
            <p>{i18n.t('projectAgent.drawer.runningEmpty')}</p>
          </div>
        ) : (
          <ul className="bot-overview-sessions">
            {running.map((session) => (
              <li key={session.sessionId}>
                <button type="button" onClick={() => onOpenSession(session.sessionId)}>
                  <span>{session.title}</span>
                  <PeerIcon name="chevronRight" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {brief && (
        <section className="bot-overview-section">
          <h2>{i18n.t('projectAgent.drawer.brief')}</h2>
          <p className="bot-overview-brief">{brief}</p>
        </section>
      )}
      <section className="bot-overview-details">
        <div>
          <span>{i18n.t('projectAgent.drawer.acceptance')}</span>
          <strong>{i18n.t('projectAgent.drawer.acceptance.auto')}</strong>
        </div>
        <div>
          <span>{i18n.t('projectAgent.drawer.model')}</span>
          <strong title={modelLabel}>{modelLabel || i18n.t('projectAgent.drawer.modelEmpty')}</strong>
        </div>
      </section>
    </div>
  );
}
