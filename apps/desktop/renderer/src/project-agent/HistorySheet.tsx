import { useEffect, useId, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { ConversationResultView } from '../app/components/ConversationResultView';
import { Overlay } from '../app/components/Overlay';
import { clientApi } from '../clientApi';

export interface HistoryConversation {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface HistoryBotChoice {
  readonly workspaceId: string;
  readonly displayName: string;
}

export function HistorySheet({
  open,
  unscoped = false,
  workspaceId = '',
  items,
  bots = [],
  i18n,
  onClose,
  onContinued,
}: {
  readonly open: boolean;
  readonly unscoped?: boolean;
  readonly workspaceId?: string;
  readonly items?: readonly HistoryConversation[];
  readonly bots?: readonly HistoryBotChoice[];
  readonly i18n: I18nRuntime;
  readonly onClose: () => void;
  readonly onContinued?: (workspaceId: string) => void;
}) {
  const titleId = useId();
  const [loaded, setLoaded] = useState<readonly HistoryConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [botId, setBotId] = useState(workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setError('');
      setBusy(false);
      return undefined;
    }
    setBotId(workspaceId);
    if (!unscoped) return undefined;
    let cancelled = false;
    void clientApi.projectAgentListHistory({ unscoped: true }).then((result) => {
      if (cancelled) return;
      setLoaded(Array.isArray(result?.history) ? result.history : []);
    }).catch(() => {
      if (!cancelled) setLoaded([]);
    });
    return () => {
      cancelled = true;
    };
  }, [open, unscoped, workspaceId]);

  if (!open) return null;
  const rows = items ?? loaded;
  const selected = rows.find((item) => item.id === selectedId) ?? null;
  const targetBot = unscoped ? botId : workspaceId;

  return (
    <Overlay
      ariaLabel={i18n.t('projectAgent.list.history')}
      panelClassName="bot-sheet bot-history-sheet"
      onClose={onClose}
    >
      <div className="bot-sheet-head">
        <h2 id={titleId}>{i18n.t('projectAgent.list.history')}</h2>
        <button type="button" className="bot-sheet-close" onClick={onClose}>
          {i18n.t('projectAgent.drawer.close')}
        </button>
      </div>
      {selected ? (
        <div className="bot-history-detail">
          <button type="button" className="bot-back" onClick={() => setSelectedId(null)}>
            {i18n.t('projectAgent.drawer.back')}
          </button>
          <ConversationResultView item={historyOverview(selected)} isZh={i18n.locale === 'zh-CN'} />
          {unscoped ? (
            <label className="bot-history-pick">
              <span>{i18n.t('projectAgent.drawer.historyPickBot')}</span>
              <select value={botId} onChange={(event) => setBotId(event.target.value)}>
                <option value="">{i18n.t('projectAgent.drawer.historyPickBot')}</option>
                {bots.map((bot) => (
                  <option key={bot.workspaceId} value={bot.workspaceId}>{bot.displayName}</option>
                ))}
              </select>
            </label>
          ) : null}
          {error ? <p className="bot-sheet-error">{error}</p> : null}
          <button
            type="button"
            className="bot-sheet-submit"
            disabled={busy || !targetBot}
            onClick={() => {
              void continueHistory(targetBot, selected.id, setBusy, setError, onContinued);
            }}
          >
            {i18n.t('projectAgent.drawer.continueHistory')}
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="bot-drawer-note">{i18n.t('projectAgent.drawer.historyEmpty')}</p>
      ) : (
        <div>
          {rows.map((item) => (
            <button
              key={item.id}
              type="button"
              className="bot-sheet-choice"
              onClick={() => {
                setError('');
                setSelectedId(item.id);
              }}
            >
              <strong>{item.title || item.id}</strong>
              {item.updatedAt ? <span>{item.updatedAt}</span> : null}
            </button>
          ))}
        </div>
      )}
    </Overlay>
  );
}

function historyOverview(item: HistoryConversation): TaskOverviewItem {
  return {
    taskId: item.id,
    source: 'conversation',
    actionRight: 'terminal',
    nextAction: 'none',
    title: item.title || item.id,
    statusLabel: item.updatedAt || '',
    actionLabel: '',
  };
}

async function continueHistory(
  workspaceId: string,
  conversationId: string,
  setBusy: (busy: boolean) => void,
  setError: (error: string) => void,
  onContinued?: (workspaceId: string) => void,
) {
  if (!workspaceId || !conversationId) return;
  setBusy(true);
  setError('');
  try {
    const result = await clientApi.projectAgentContinueHistory({
      workspaceId,
      conversationId,
      inputId: crypto.randomUUID(),
    });
    if (!result?.ok) {
      setError(result?.code || 'INVALID_INPUT');
      return;
    }
    onContinued?.(workspaceId);
  } catch (error) {
    setError(error instanceof Error ? error.message : 'INVALID_INPUT');
  } finally {
    setBusy(false);
  }
}
