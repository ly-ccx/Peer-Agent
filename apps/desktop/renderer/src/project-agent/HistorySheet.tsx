import { useEffect, useId, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { Overlay } from '../app/components/Overlay';
import { clientApi } from '../clientApi';
import { Dropdown } from '../app/components/Dropdown';
import { MarkdownMessage } from '../chat/components/markdown/MarkdownMessage';
import { PeerIcon } from '../ui/icons';
import { formatDrawerStamp } from './state/drawerState';
import { historyTitle, type HistoryConversation } from './state/historyPresentation';
import { HistoryConversationList } from './HistoryConversationList';
import './styles/bot-history.css';
export type { HistoryConversation } from './state/historyPresentation';

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
  const [readState, setReadState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [previewState, setPreviewState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [readEpoch, setReadEpoch] = useState(0);
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [continuedTo, setContinuedTo] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setLines([]);
      setNeedsConfirm(false);
      setError('');
      setBusy(false);
      setLoaded([]);
      setReadState('loading');
      setContinuedTo(null);
      return undefined;
    }
    setBotId(workspaceId);
    if (!unscoped) return undefined;
    let cancelled = false;
    setLoaded([]);
    setReadState('loading');
    void clientApi.projectAgentListHistory({ unscoped: true }).then((result) => {
      if (cancelled) return;
      setLoaded(Array.isArray(result?.history) ? result.history : []);
      setReadState(result?.ok ? 'ready' : 'unavailable');
    }).catch(() => {
      if (!cancelled) { setLoaded([]); setReadState('unavailable'); }
    });
    return () => {
      cancelled = true;
    };
  }, [open, unscoped, workspaceId, readEpoch]);

  useEffect(() => {
    if (!open || !selectedId) {
      setLines([]);
      setNeedsConfirm(false);
      return undefined;
    }
    let cancelled = false;
    setNeedsConfirm(false);
    setLines([]);
    setPreviewState('loading');
    void clientApi.conversationsGet({ id: selectedId }).then((result) => {
      if (cancelled) return;
      setLines(historyLines(result?.messages));
      setPreviewState(result ? 'ready' : 'unavailable');
    }).catch(() => {
      if (!cancelled) { setLines([]); setPreviewState('unavailable'); }
    });
    return () => {
      cancelled = true;
    };
  }, [open, selectedId, previewEpoch]);

  if (!open) return null;
  const rows = items ?? loaded;
  const selected = rows.find((item) => item.id === selectedId) ?? null;
  const targetBot = unscoped ? botId : workspaceId;

  return (
    <Overlay
      ariaLabel={i18n.t('projectAgent.list.history')}
      panelClassName="bot-sheet bot-history-sheet"
      backdropClassName="bot-history-backdrop"
      onClose={() => { if (continuedTo && onContinued) onContinued(continuedTo); else onClose(); }}
    >
      {({ requestClose }) => <>
      <div className="bot-sheet-head">
        <div><h2 id={titleId}>{selected ? historyTitle(selected, i18n.t('projectAgent.history.untitled')) : i18n.t('projectAgent.list.history')}</h2>
          <p>{selected ? formatDrawerStamp(selected.updatedAt) : i18n.t('projectAgent.history.hint')}</p></div>
        <button type="button" className="bot-sheet-close" aria-label={i18n.t('projectAgent.drawer.close')} onClick={requestClose}>
          <PeerIcon name="close" size={18} />
        </button>
      </div>
      {selected ? (
        <div className="bot-history-detail">
          <button type="button" className="bot-history-back" onClick={() => setSelectedId(null)}>
            <PeerIcon name="chevronLeft" size={15} />{i18n.t('projectAgent.history.back')}
          </button>
          <div className="bot-history-log" aria-busy={previewState === 'loading'}>
            {previewState !== 'ready' ? <p className="bot-history-empty" role="status">{i18n.t(previewState === 'loading'
              ? 'projectAgent.history.loadingPreview' : 'projectAgent.history.previewUnavailable')}
              {previewState === 'unavailable' ? <button type="button" onClick={() => setPreviewEpoch(value => value + 1)}>{i18n.t('projectAgent.history.retry')}</button> : null}
            </p> : !lines.length ? <p className="bot-history-empty">{i18n.t('projectAgent.history.noPreview')}</p> : null}
            {lines.map((line) => (
              <article key={line.id} className="bot-history-line" data-role={line.role}>
                <span>{i18n.t(line.role === 'user' ? 'projectAgent.history.user' : 'projectAgent.history.assistant')}</span>
                {line.role === 'assistant' ? <MarkdownMessage content={line.text} /> : <p>{line.text || i18n.t('projectAgent.history.attachmentOnly')}</p>}
              </article>
            ))}
          </div>
          <div className="bot-history-actions">
          {unscoped ? (
            <div className="bot-history-pick">
              <span>{i18n.t('projectAgent.drawer.historyPickBot')}</span>
              <Dropdown value={botId} options={bots.map(bot => ({ value: bot.workspaceId, label: bot.displayName }))}
                onChange={setBotId} disabled={busy || !bots.length} ariaLabel={i18n.t('projectAgent.drawer.historyPickBot')}
                placeholder={i18n.t('projectAgent.drawer.historyPickBot')} searchable menuPlacement="up" />
            </div>
          ) : null}
          {needsConfirm ? <p className="bot-history-confirm">{i18n.t('projectAgent.drawer.historyPartial')}</p> : null}
          {error ? <p className="bot-sheet-error" role="alert">{i18n.t('projectAgent.history.continueFailed')}</p> : null}
          <button
            type="button"
            className="bot-sheet-submit"
            disabled={busy || !targetBot || previewState !== 'ready'}
            onClick={() => {
              void continueHistory(
                targetBot,
                selected.id,
                needsConfirm,
                setBusy,
                setError,
                setNeedsConfirm,
                workspaceId => { setContinuedTo(workspaceId); requestClose(); },
              );
            }}
          >
            {i18n.t(busy ? 'projectAgent.history.submitting' : needsConfirm
              ? 'projectAgent.drawer.historyPartialConfirm'
              : 'projectAgent.drawer.continueHistory')}
          </button>
          </div>
        </div>
      ) : null}
      <HistoryConversationList items={rows} active={!selected} state={items || !unscoped ? 'ready' : readState}
        i18n={i18n} onRetry={() => setReadEpoch(value => value + 1)} onChoose={id => { setError(''); setLines([]); setPreviewState('loading'); setSelectedId(id); }} />
      </>}
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
  }).filter(line => line.role === 'user' || line.role === 'assistant');
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
