import { useEffect, useId, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
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

interface HistoryLine {
  readonly id: string;
  readonly role: string;
  readonly text: string;
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
  const [lines, setLines] = useState<readonly HistoryLine[]>([]);
  const [botId, setBotId] = useState(workspaceId);
  const [busy, setBusy] = useState(false);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setLines([]);
      setNeedsConfirm(false);
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

  useEffect(() => {
    if (!open || !selectedId) {
      setLines([]);
      setNeedsConfirm(false);
      return undefined;
    }
    let cancelled = false;
    setNeedsConfirm(false);
    void clientApi.conversationsGet({ id: selectedId }).then((result) => {
      if (cancelled) return;
      setLines(historyLines(result?.messages));
    }).catch(() => {
      if (!cancelled) setLines([]);
    });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId]);

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
          <div className="bot-history-log">
            {lines.map((line) => (
              <article key={line.id} className="bot-history-line">
                <span>{line.role}</span>
                {line.text ? <p>{line.text}</p> : null}
              </article>
            ))}
          </div>
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
          {needsConfirm ? <p className="bot-history-confirm">{i18n.t('projectAgent.drawer.historyPartial')}</p> : null}
          {error ? <p className="bot-sheet-error">{error}</p> : null}
          <button
            type="button"
            className="bot-sheet-submit"
            disabled={busy || !targetBot}
            onClick={() => {
              void continueHistory(
                targetBot,
                selected.id,
                needsConfirm,
                setBusy,
                setError,
                setNeedsConfirm,
                onContinued,
              );
            }}
          >
            {i18n.t(needsConfirm
              ? 'projectAgent.drawer.historyPartialConfirm'
              : 'projectAgent.drawer.continueHistory')}
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

function historyLines(messages: unknown): readonly HistoryLine[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((message, index) => {
    const row = message && typeof message === 'object' ? message as Record<string, unknown> : {};
    const id = typeof row.id === 'string' && row.id ? row.id : String(index);
    const role = typeof row.role === 'string' ? row.role : '';
    return { id, role, text: textOf(row.content) };
  });
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
      return (part as { text: string }).text;
    }
    return '';
  }).filter(Boolean).join('\n');
}

async function continueHistory(
  workspaceId: string,
  conversationId: string,
  confirmMissing: boolean,
  setBusy: (busy: boolean) => void,
  setError: (error: string) => void,
  setNeedsConfirm: (needed: boolean) => void,
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
      ...(confirmMissing ? { confirmMissing: true } : {}),
    });
    if (result?.code === 'BACKGROUND_CONFIRMATION_REQUIRED') {
      setNeedsConfirm(true);
      return;
    }
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
