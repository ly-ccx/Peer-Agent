import { useEffect, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../../clientApi';

interface LegacyAutomation {
  readonly definition?: {
    readonly automationId?: string;
    readonly name?: string;
    readonly workspacePath?: string;
  };
}

export function ObjectivesTab({
  workspacePath,
  i18n,
  onOpenAutomations,
}: {
  readonly workspacePath: string;
  readonly i18n: I18nRuntime;
  readonly onOpenAutomations?: () => void;
}) {
  const [items, setItems] = useState<readonly LegacyAutomation[]>([]);

  useEffect(() => {
    if (!workspacePath) {
      setItems([]);
      return undefined;
    }
    let cancelled = false;
    void clientApi.automationsList().then((rows) => {
      if (cancelled) return;
      const listed = Array.isArray(rows) ? rows as readonly LegacyAutomation[] : [];
      setItems(listed.filter((item) => item?.definition?.workspacePath === workspacePath));
    }).catch(() => {
      if (!cancelled) setItems([]);
    });
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  return (
    <div className="bot-drawer-tab bot-objectives-tab">
      <div className="bot-objectives-intro">
        <span className="bot-objectives-icon" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="16" cy="16" r="11" />
            <circle cx="16" cy="16" r="6" />
            <circle cx="16" cy="16" r="1.5" />
          </svg>
        </span>
        <h2>{i18n.t('projectAgent.drawer.objectives.body')}</h2>
        <p>{i18n.t('projectAgent.drawer.objectives.hint')}</p>
      </div>
      {items.length > 0 && (
        <section className="bot-tasks-section">
          <div className="bot-tasks-heading">
            <h2>{i18n.t('projectAgent.drawer.legacyAutomations')}</h2>
            <span>{items.length}</span>
          </div>
          <ul className="bot-tasks-list">
            {items.map((item) => {
              const id = item.definition?.automationId || item.definition?.name || '';
              return (
                <li key={id}>
                  <button type="button" className="bot-task-row" onClick={() => onOpenAutomations?.()}>
                    <span className="bot-task-row-copy">
                      <span className="bot-task-row-title">{item.definition?.name || id}</span>
                    </span>
                    <span className="bot-task-row-arrow" aria-hidden="true">›</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
