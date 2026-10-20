import { useEffect, useRef, useState } from 'react';
import type { BotAttentionItem } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import { clientApi } from '../clientApi';
import { Overlay } from '../app/components/Overlay';
import { PeerIcon } from '../ui/icons';
import { CardView } from './conversation/CardView';
import './styles/bot-attention.css';

/** Live host facts; never a second store of approvals or task state. */
export function AttentionSheet({ workspaceId, i18n, onClose, onLocate, onChanged }: {
  readonly workspaceId?: string;
  readonly i18n: I18nRuntime;
  readonly onClose: () => void;
  readonly onLocate: (item: BotAttentionItem) => void;
  readonly onChanged: () => void;
}) {
  const [items, setItems] = useState<readonly BotAttentionItem[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const locateAfterClose = useRef<BotAttentionItem | null>(null);
  const reload = () => { setRevision(n => n + 1); onChanged(); };
  useEffect(() => {
    const request = ++epoch.current;
    let disposed = false;
    // Keep readable items while refreshing; failures never masquerade as an empty list.
    void clientApi.projectAgentListAttention(workspaceId ? { workspaceId } : {}).then(result => {
      if (disposed || request !== epoch.current) return;
      if (!result.ok) { setState('error'); return; }
      setItems(result.items); setState('ready');
    }).catch(() => { if (!disposed && request === epoch.current) setState('error'); });
    return () => { disposed = true; };
  }, [workspaceId, revision]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (event: { workspaceIds: readonly string[] }) => {
      if (workspaceId && !event.workspaceIds.includes(workspaceId)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setRevision(n => n + 1), 100);
    };
    const stop = clientApi.onProjectAgentChanged(changed);
    const stopConversation = clientApi.onProjectAgentConversationChanged(changed);
    return () => { stop(); stopConversation(); if (timer) clearTimeout(timer); };
  }, [workspaceId]);
  const grouped = new Map<string, BotAttentionItem[]>();
  for (const item of items) grouped.set(item.workspaceId, [...(grouped.get(item.workspaceId) || []), item]);
  return <Overlay ariaLabel={i18n.t('projectAgent.attention.title')} panelClassName="bot-sheet bot-attention-sheet" onClose={() => { const target = locateAfterClose.current; onClose(); if (target) onLocate(target); }}>
    {({ requestClose }) => <>
      <header className="bot-sheet-head">
        <div><h2>{i18n.t('projectAgent.attention.title')}</h2><p>{i18n.t('projectAgent.attention.subtitle')}</p></div>
        <button type="button" className="bot-sheet-close" aria-label={i18n.t('projectAgent.attention.close')} onClick={requestClose}><PeerIcon name="close" size={18} /></button>
      </header>
      <div className="bot-attention-body" aria-busy={state === 'loading'}>
        {state === 'loading' ? <p role="status">{i18n.t('projectAgent.list.loading')}</p> : null}
        {state === 'error' ? <div role="alert"><p>{i18n.t('projectAgent.attention.failed')}</p><button type="button" onClick={reload}>{i18n.t('projectAgent.attention.retry')}</button></div> : null}
        {state === 'ready' && !items.length ? <div className="bot-attention-empty" role="status"><PeerIcon name="check" size={24} /><h3>{i18n.t('projectAgent.attention.empty')}</h3><p>{i18n.t('projectAgent.attention.emptyHint')}</p></div> : null}
        {[...grouped].map(([id, rows]) => <section className="bot-attention-group" key={id}>
          <h3>{rows[0].botName}<span>{rows.length}</span></h3>
          {rows.map(item => <article className="bot-attention-item" key={item.id} data-attention-id={item.id}>
            <p className="bot-attention-kind">{i18n.t(item.kind === 'question' ? 'projectAgent.attention.question' : item.kind === 'approval' ? 'projectAgent.attention.approval' : 'projectAgent.attention.confirmation')}</p>
            {item.kind === 'question' || !item.card ? <p className="bot-attention-title">{item.title}</p> : null}
            {item.card ? <CardView workspaceId={item.workspaceId} cards={[item.card]} i18n={i18n} onDone={reload} /> : null}
            {item.messageId || item.sessionId ? <button type="button" className="bot-attention-source" onClick={() => { locateAfterClose.current = item; requestClose(); }}>{i18n.t('projectAgent.attention.openSource')}<PeerIcon name="arrowUpRight" size={14} /></button> : null}
          </article>)}
        </section>)}
      </div>
    </>}
  </Overlay>;
}
