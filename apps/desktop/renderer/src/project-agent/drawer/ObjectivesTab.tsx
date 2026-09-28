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
    <section className="bot-drawer-tab">
      <h2>{i18n.t('projectAgent.drawer.legacyAutomations')}</h2>
      {items.length === 0 ? (
        <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.legacyAutomationsEmpty')}</p>
      ) : (
        <ul>
          {items.map((item) => {
            const id = item.definition?.automationId || item.definition?.name || '';
            return (
              <li key={id}>
                <button type="button" onClick={() => onOpenAutomations?.()}>
                  <span>{item.definition?.name || id}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.objectives.body')}</p>
    </section>
  );
}
