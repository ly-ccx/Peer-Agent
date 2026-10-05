import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProcessDisclosure } from './BotProcess';
import { PeerIcon } from '../../ui/icons';
import type { BotWorkRow } from '../state/botWorkState';
import { formatDrawerSessionStatus } from '../state/drawerState';
import '../styles/bot-reply-context.css';
import '../styles/bot-disclosure.css';

export function DelegatedWork({ rows, i18n, onOpen, disclosure }: { readonly rows: readonly BotWorkRow[]; readonly i18n: I18nRuntime; readonly onOpen: (id: string) => void; readonly disclosure?: ProcessDisclosure }) {
  if (!rows.length) return null;
  return <section className="bot-delegated-work" aria-label={i18n.t('projectAgent.chat.work.heading')}>
    {rows.slice(0, 3).map(row => <WorkRow key={row.id} row={row} i18n={i18n} onOpen={onOpen} disclosure={disclosure} />)}
    {rows.length > 3 ? <details className="bot-work-more" open={disclosure ? disclosure.open['work:more'] ?? false : undefined} onToggle={event => { if (event.target === event.currentTarget) disclosure?.toggle('work:more', event.currentTarget.open); }}><summary>{i18n.t('projectAgent.chat.work.more', { count: rows.length - 3 })}<PeerIcon name="chevronDown" size={12} /></summary>
      {rows.slice(3).map(row => <WorkRow key={row.id} row={row} i18n={i18n} onOpen={onOpen} disclosure={disclosure} />)}</details> : null}
  </section>;
}
function WorkRow({ row, i18n, onOpen, disclosure }: { readonly row: BotWorkRow; readonly i18n: I18nRuntime; readonly onOpen: (id: string) => void; readonly disclosure?: ProcessDisclosure }) {
  const active = ['starting', 'running', 'verifying'].includes(row.status ?? '');
  return <details className="bot-work-row" data-status={row.status ?? 'unavailable'} open={disclosure ? disclosure.open[`work:${row.id}`] ?? false : undefined} onToggle={event => { if (event.target === event.currentTarget) disclosure?.toggle(`work:${row.id}`, event.currentTarget.open); }}>
    <summary><PeerIcon name={row.status === 'waiting_user' ? 'info' : 'terminal'} size={14} />
      <span className="bot-work-title">{row.session?.title && row.session.title !== row.id ? row.session.title : i18n.t('projectAgent.chat.work.related')}</span>
      <span className={`bot-work-status${active ? ' is-running' : ''}`}>{row.status ? i18n.t(`projectAgent.chat.sessionState.${row.status}`) : i18n.t('projectAgent.chat.work.unavailable')}</span>
      <PeerIcon name="chevronDown" size={12} /></summary>
    <div className="bot-work-detail">
      {row.status && row.session ? <p>{row.session.summary || (formatDrawerSessionStatus(row.session, i18n) !== row.status ? formatDrawerSessionStatus(row.session, i18n) : i18n.t(`projectAgent.chat.sessionState.${row.status}`))}</p> : <p>{i18n.t('projectAgent.chat.work.unavailableHint')}</p>}
      <button type="button" onClick={() => onOpen(row.id)}>{i18n.t(row.status === 'waiting_user' || row.status === 'result_ready' ? 'projectAgent.chat.work.handle' : 'projectAgent.chat.work.open')}<PeerIcon name="arrowUpRight" size={13} /></button>
    </div>
  </details>;
}
