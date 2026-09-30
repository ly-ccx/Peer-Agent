import { useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { HistoryConversation } from '../HistorySheet';
import { formatDrawerStamp, groupDrawerSessions, type DrawerSession, type TaskGroup } from '../state/drawerState';

const GROUP_KEY = {
  needsYou: 'projectAgent.drawer.group.needsYou',
  running: 'projectAgent.drawer.group.running',
  queued: 'projectAgent.drawer.group.queued',
  done: 'projectAgent.drawer.group.done',
} as const;
const PREVIEW_COUNT = 5;

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
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [showAllClassic, setShowAllClassic] = useState(false);
  const groups = groupDrawerSessions(sessions);
  if (sessions.length === 0 && history.length === 0 && goals.length === 0) {
    return (
      <div className="bot-drawer-tab bot-tasks-tab">
        <div className="bot-tasks-empty">
          <svg viewBox="0 0 32 32" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="6" y="5" width="20" height="23" rx="4" />
            <path d="M11 12h10M11 18h10M11 24h6" />
          </svg>
          <strong>{i18n.t('projectAgent.drawer.tasksEmpty')}</strong>
        </div>
      </div>
    );
  }
  return (
    <div className="bot-drawer-tab bot-tasks-tab">
      {(Object.keys(GROUP_KEY) as TaskGroup[]).map((group) => (
        groups[group].length === 0 ? null : (
          <section className="bot-tasks-section" key={group}>
            <div className="bot-tasks-heading">
              <h2>{i18n.t(GROUP_KEY[group])}</h2>
              <span>{groups[group].length}</span>
            </div>
            <ul className="bot-tasks-list">
              {groups[group].map((session) => (
                <li key={session.sessionId}>
                  <button
                    type="button"
                    className={session.sessionId === selectedId ? 'bot-task-row is-selected' : 'bot-task-row'}
                    onClick={() => onSelect(session.sessionId)}
                  >
                    <span className="bot-task-row-copy">
                      <span className="bot-task-row-title">{session.title}</span>
                      <span className="bot-task-row-meta">{session.statusLabel || session.status}</span>
                    </span>
                    <span className="bot-task-row-arrow" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      ))}
      {history.length === 0 ? null : (
        <section className="bot-tasks-section">
          <div className="bot-tasks-heading">
            <h2>{i18n.t('projectAgent.drawer.group.history')}</h2>
            <span>{history.length}</span>
          </div>
          <ul className="bot-tasks-list">
            {(showAllHistory ? history : history.slice(0, PREVIEW_COUNT)).map((item) => (
              <li key={item.id}>
                <button type="button" className="bot-task-row" onClick={() => onOpenHistory?.(item.id)}>
                  <span className="bot-task-row-copy">
                    <span className="bot-task-row-title">{item.title || item.id}</span>
                    <span className="bot-task-row-meta">{formatDrawerStamp(item.updatedAt)}</span>
                  </span>
                  <span className="bot-task-row-arrow" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
          {history.length > PREVIEW_COUNT && (
            <button
              type="button"
              className="bot-tasks-more"
              aria-expanded={showAllHistory}
              onClick={() => setShowAllHistory((current) => !current)}
            >
              {i18n.t(showAllHistory ? 'projectAgent.drawer.collapse' : 'projectAgent.drawer.showAll')}
              <span aria-hidden="true">{showAllHistory ? '↑' : '↓'}</span>
            </button>
          )}
        </section>
      )}
      {goals.length === 0 ? null : (
        <section className="bot-tasks-section">
          <div className="bot-tasks-heading">
            <h2>{i18n.t('projectAgent.drawer.group.classic')}</h2>
            <span>{goals.length}</span>
          </div>
          <ul className="bot-tasks-list">
            {(showAllClassic ? goals : goals.slice(0, PREVIEW_COUNT)).map((goal) => (
              <li key={goal.planId}>
                <button
                  type="button"
                  className="bot-task-row"
                  disabled={!goal.conversationId}
                  onClick={() => onOpenClassic?.(goal)}
                >
                  <span className="bot-task-row-copy">
                    <span className="bot-task-row-title">{goal.title || goal.planId}</span>
                    <span className="bot-task-row-meta">{i18n.t('projectAgent.drawer.classicOpen')}</span>
                  </span>
                  <span className="bot-task-row-arrow" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
          </ul>
          {goals.length > PREVIEW_COUNT && (
            <button
              type="button"
              className="bot-tasks-more"
              aria-expanded={showAllClassic}
              onClick={() => setShowAllClassic((current) => !current)}
            >
              {i18n.t(showAllClassic ? 'projectAgent.drawer.collapse' : 'projectAgent.drawer.showAll')}
              <span aria-hidden="true">{showAllClassic ? '↑' : '↓'}</span>
            </button>
          )}
        </section>
      )}
    </div>
  );
}
