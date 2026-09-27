import type { I18nRuntime } from '@peer-agent/i18n';
import { groupDrawerSessions, type DrawerSession, type TaskGroup } from '../state/drawerState';

const GROUP_KEY = {
  needsYou: 'projectAgent.drawer.group.needsYou',
  running: 'projectAgent.drawer.group.running',
  queued: 'projectAgent.drawer.group.queued',
  done: 'projectAgent.drawer.group.done',
} as const;

export function TasksTab({
  sessions,
  selectedId,
  i18n,
  onSelect,
}: {
  readonly sessions: readonly DrawerSession[];
  readonly selectedId: string | null;
  readonly i18n: I18nRuntime;
  readonly onSelect: (sessionId: string) => void;
}) {
  const groups = groupDrawerSessions(sessions);
  if (sessions.length === 0) return <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.tasksEmpty')}</p>;
  return (
    <div className="bot-drawer-tab">
      {(Object.keys(GROUP_KEY) as TaskGroup[]).map((group) => (
        groups[group].length === 0 ? null : (
          <section key={group}>
            <h2>{i18n.t(GROUP_KEY[group])}</h2>
            <ul>
              {groups[group].map((session) => (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className={session.sessionId === selectedId ? 'is-selected' : undefined}
                    onClick={() => onSelect(session.sessionId)}
                  >
                    <span>{session.title}</span>
                    <span>{session.statusLabel || session.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      ))}
    </div>
  );
}
