import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProcessDisclosure } from './BotProcess';
import { PeerIcon } from '../../ui/icons';
import { workProgress, type BotWorkRow } from '../state/botWorkState';
import { formatDrawerSessionStatus } from '../state/drawerState';
import { TaskCancelButton } from '../state/TaskCancellation';
import '../styles/bot-reply-context.css';
import '../styles/bot-disclosure.css';

export function DelegatedWork({ rows, botName, i18n, onOpen, disclosure }: { readonly rows: readonly BotWorkRow[]; readonly botName: string; readonly i18n: I18nRuntime; readonly onOpen: (id: string) => void; readonly disclosure?: ProcessDisclosure }) {
  if (!rows.length) return null;
  return <section className="bot-delegated-work" aria-label={i18n.t('projectAgent.chat.work.heading')}>
    {rows.slice(0, 3).map(row => <WorkRow key={row.id} row={row} botName={botName} i18n={i18n} onOpen={onOpen} disclosure={disclosure} />)}
    {rows.length > 3 ? <details className="bot-work-more" open={disclosure ? disclosure.open['work:more'] ?? false : undefined} onToggle={event => { if (event.target === event.currentTarget) disclosure?.toggle('work:more', event.currentTarget.open); }}><summary>{i18n.t('projectAgent.chat.work.more', { count: rows.length - 3 })}<PeerIcon name="chevronDown" size={12} /></summary>
      {rows.slice(3).map(row => <WorkRow key={row.id} row={row} botName={botName} i18n={i18n} onOpen={onOpen} disclosure={disclosure} />)}</details> : null}
  </section>;
}
function WorkRow({ row, botName, i18n, onOpen, disclosure }: { readonly row: BotWorkRow; readonly botName: string; readonly i18n: I18nRuntime; readonly onOpen: (id: string) => void; readonly disclosure?: ProcessDisclosure }) {
  const active = ['starting', 'running', 'verifying'].includes(row.status ?? '');
  const handoff = row.status === 'waiting_user' || row.status === 'result_ready';
  const statusKey = row.status === 'waiting_user' ? 'projectAgent.chat.work.waiting'
    : row.status === 'result_ready' ? 'projectAgent.chat.work.resultReady'
    : row.status ? `projectAgent.chat.sessionState.${row.status}` as const : 'projectAgent.chat.work.unavailable';
  return <details className="bot-work-row" data-status={row.status ?? 'unavailable'} open={disclosure ? disclosure.open[`work:${row.id}`] ?? false : undefined} onToggle={event => { if (event.target === event.currentTarget) disclosure?.toggle(`work:${row.id}`, event.currentTarget.open); }}>
    <summary><PeerIcon name={row.status === 'waiting_user' ? 'info' : 'terminal'} size={14} />
      <span className="bot-work-title">{row.session?.title && row.session.title !== row.id ? row.session.title : i18n.t('projectAgent.chat.work.related')}</span>
      <span className={`bot-work-status${active ? ' is-running' : ''}`}>{row.session?.coordination?.phase === 'stopping' ? formatDrawerSessionStatus(row.session,i18n) : i18n.t(statusKey)}</span>
      <PeerIcon name="chevronDown" size={12} /></summary>
    <div className="bot-work-detail">
      <p>{workProgress(row, i18n)}</p>
      {handoff ? <p className="bot-work-hint">{i18n.t('projectAgent.chat.work.handoff', { name: botName })}</p> : null}
      <div className="bot-work-actions">
        <button type="button" onClick={() => onOpen(row.id)}>{i18n.t('projectAgent.chat.work.open')}<PeerIcon name="arrowUpRight" size={13} /></button>
        <TaskCancelButton sessionId={row.id} status={row.status} title={row.session?.title ?? i18n.t('projectAgent.chat.work.related')} i18n={i18n} />
      </div>
    </div>
  </details>;
}
