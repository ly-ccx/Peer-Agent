import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../ui/icons';
import { formatDrawerStamp } from './state/drawerState';
import { HISTORY_PAGE_SIZE, historyTitle, presentHistory, type HistoryConversation } from './state/historyPresentation';

export function HistoryConversationList({ items, active, state, i18n, onChoose, onRetry }: {
  readonly items: readonly HistoryConversation[];
  readonly active: boolean;
  readonly state: 'loading' | 'ready' | 'unavailable';
  readonly i18n: I18nRuntime;
  readonly onChoose: (id: string) => void;
  readonly onRetry: () => void;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(HISTORY_PAGE_SIZE);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const lastChosen = useRef('');
  const nextPageFocus = useRef<number | null>(null);
  const resultsId = useId();
  const view = useMemo(() => presentHistory(items, query, limit), [items, query, limit]);
  const buttons = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>('.bot-history-row') ?? []);
  useEffect(() => {
    if (!active) return;
    const previous = buttons().find(node => node.dataset.historyId === lastChosen.current);
    (previous ?? search.current)?.focus({ preventScroll: true });
  }, [active]);
  useEffect(() => {
    if (nextPageFocus.current === null) return;
    buttons()[nextPageFocus.current]?.focus();
    nextPageFocus.current = null;
  }, [limit]);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const rows = buttons(); const index = rows.indexOf(event.currentTarget);
    const target = event.key === 'ArrowDown' ? rows[index + 1] : event.key === 'ArrowUp' ? rows[index - 1] ?? search.current
      : event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1) : null;
    if (target) { event.preventDefault(); target.focus(); }
  };
  return <div className="bot-history-browser" ref={root} hidden={!active}>
    <div className="bot-history-search"><PeerIcon name="search" size={17} />
      <input ref={search} type="search" data-overlay-autofocus aria-label={i18n.t('projectAgent.history.search')}
        aria-controls={resultsId} placeholder={i18n.t('projectAgent.history.search')} value={query}
        onChange={event => { setQuery(event.target.value); setLimit(HISTORY_PAGE_SIZE); }}
        onKeyDown={event => { if (event.key === 'ArrowDown' && buttons()[0]) { event.preventDefault(); buttons()[0].focus(); } }} />
      {query ? <button type="button" aria-label={i18n.t('projectAgent.history.clear')} onClick={() => {
        setQuery(''); setLimit(HISTORY_PAGE_SIZE); search.current?.focus();
      }}><PeerIcon name="close" size={14} /></button> : null}
    </div>
    <div className="bot-history-results" id={resultsId} aria-busy={state === 'loading'}>
      {state !== 'ready' ? <div className="bot-history-empty" role="status"><PeerIcon name="history" size={22} />
        <p>{i18n.t(state === 'loading' ? 'projectAgent.history.loading' : 'projectAgent.history.unavailable')}</p>
        {state === 'unavailable' ? <button type="button" onClick={onRetry}>{i18n.t('projectAgent.history.retry')}</button> : null}
      </div> : !view.count ? <div className="bot-history-empty" role="status"><PeerIcon name="history" size={22} />
        <p>{i18n.t(query.trim() ? 'projectAgent.history.noMatch' : 'projectAgent.drawer.historyEmpty')}</p>
      </div> : view.groups.map(group => <section className="bot-history-group" key={group.key} aria-label={i18n.t(`projectAgent.history.group.${group.key}`)}>
        <h3>{i18n.t(`projectAgent.history.group.${group.key}`)}</h3>
        <ul>{group.rows.map(item => <li key={item.id}><button type="button" className="bot-history-row" data-history-id={item.id}
          onKeyDown={move} onClick={() => { lastChosen.current = item.id; onChoose(item.id); }}>
          <span className="bot-history-row-title" title={historyTitle(item, i18n.t('projectAgent.history.untitled'))}>{historyTitle(item, i18n.t('projectAgent.history.untitled'))}</span>
          {formatDrawerStamp(item.updatedAt) ? <time dateTime={item.updatedAt}>{formatDrawerStamp(item.updatedAt)}</time> : null}
          <PeerIcon name="chevronRight" size={14} />
        </button></li>)}</ul>
      </section>)}
      {state === 'ready' && view.hasMore ? <button className="bot-history-more" type="button" onClick={() => { nextPageFocus.current = view.shown; setLimit(value => value + HISTORY_PAGE_SIZE); }}>
        {i18n.t('projectAgent.history.more')}<PeerIcon name="chevronDown" size={14} />
      </button> : null}
    </div>
    {state === 'ready' && view.count ? <footer className="bot-history-list-footer" role="status">
      {i18n.t('projectAgent.history.count', { shown: view.shown, count: view.count })}
    </footer> : null}
  </div>;
}
