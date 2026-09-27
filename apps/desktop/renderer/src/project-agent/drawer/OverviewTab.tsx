import type { I18nRuntime } from '@peer-agent/i18n';
import type { DrawerMemoryItem, DrawerSession } from '../state/drawerState';

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
  return (
    <div className="bot-drawer-tab">
      <section>
        <h2>{i18n.t('projectAgent.drawer.folder')}</h2>
        <p>{path || i18n.t('projectAgent.drawer.noPath')}</p>
        <button type="button" disabled={!path} onClick={onReveal}>
          {i18n.t('projectAgent.drawer.reveal')}
        </button>
      </section>
      <section>
        <h2>{i18n.t('projectAgent.drawer.brief')}</h2>
        <p>{brief || i18n.t('projectAgent.drawer.briefEmpty')}</p>
      </section>
      <section>
        <h2>{i18n.t('projectAgent.drawer.running')}</h2>
        {running.length === 0 ? <p>{i18n.t('projectAgent.drawer.runningEmpty')}</p> : (
          <ul>
            {running.map((session) => (
              <li key={session.sessionId}>
                <button type="button" onClick={() => onOpenSession(session.sessionId)}>
                  {session.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>{i18n.t('projectAgent.drawer.acceptance')}</h2>
        <p>{i18n.t('projectAgent.drawer.acceptance.auto')}</p>
        <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.acceptance.pending')}</p>
      </section>
      <section>
        <h2>{i18n.t('projectAgent.drawer.model')}</h2>
        <p>{modelLabel || i18n.t('projectAgent.drawer.modelEmpty')}</p>
      </section>
    </div>
  );
}
