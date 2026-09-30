import type { I18nRuntime } from '@peer-agent/i18n';
import type { HistoryConversation } from '../HistorySheet';
import { formatDrawerStamp, groupDrawerSessions, type DrawerSession, type TaskGroup } from '../state/drawerState';

const GROUP_KEY = {
  needsYou: 'projectAgent.drawer.group.needsYou',
  running: 'projectAgent.drawer.group.running',
  queued: 'projectAgent.drawer.group.queued',
  done: 'projectAgent.drawer.group.done',
} as const;

export interface ClassicGoalRow {
  readonly planId: string;
  readonly conversationId: string;
  readonly title: string;
  readonly status: string;
  readonly waitingUser: boolean;
}

export function TasksTab({
  sessions,
  history = [],
  goals = [],
  selectedId,
  i18n,
  onSelect,
  onOpenHistory,
  onOpenClassic,
}: {
  readonly sessions: readonly DrawerSession[];
  readonly history?: readonly HistoryConversation[];
  readonly goals?: readonly ClassicGoalRow[];
  readonly selectedId: string | null;
  readonly i18n: I18nRuntime;
  readonly onSelect: (sessionId: string) => void;
  readonly onOpenHistory?: (conversationId: string) => void;
  readonly onOpenClassic?: (goal: ClassicGoalRow) => void;
}) {
  const groups = groupDrawerSessions(sessions);
  if (sessions.length === 0 && history.length === 0 && goals.length === 0) {
    return <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.tasksEmpty')}</p>;
  }
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
      {history.length === 0 ? null : (
        <section>
          <h2>{i18n.t('projectAgent.drawer.group.history')}</h2>
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => onOpenHistory?.(item.id)}>
                  <span>{item.title || item.id}</span>
                  <span>{formatDrawerStamp(item.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {goals.length === 0 ? null : (
        <section>
          <h2>{i18n.t('projectAgent.drawer.group.classic')}</h2>
          <ul>
            {goals.map((goal) => (
              <li key={goal.planId}>
                <button
                  type="button"
                  disabled={!goal.conversationId}
                  onClick={() => onOpenClassic?.(goal)}
                >
                  <span>{goal.title || goal.planId}</span>
                  <span>{i18n.t('projectAgent.drawer.classicOpen')}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
