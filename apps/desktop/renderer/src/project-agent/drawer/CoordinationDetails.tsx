import type { I18nRuntime } from '@peer-agent/i18n';
import type { DrawerSession } from '../state/drawerState';
import { PeerIcon } from '../../ui/icons';

/** Renders host receipts and task relationships; it never drives a transition. */
export function CoordinationDetails({session,i18n,onSelect}: {readonly session:DrawerSession;readonly i18n:I18nRuntime;readonly onSelect?:(id:string)=>void}) {
  const facts=session.coordination;
  if (!facts || facts.action==='parallel') return null;
  const key=facts.phase==='awaiting_outcome' ? 'unknown' : facts.phase==='blocked' ? 'blocked' : facts.phase==='completed' ? 'applied' : 'pending';
  const related=facts.replacementSessionId && facts.replacementSessionId!==session.sessionId ? facts.replacementSessionId
    : facts.priorSessionId!==session.sessionId ? facts.priorSessionId : undefined;
  return <section className="bot-task-instructions bot-task-adjustment" aria-label={i18n.t('projectAgent.task.coordination.heading')}>
    <h3>{i18n.t('projectAgent.task.coordination.heading')}</h3>
    <p>{facts.reason}</p>
    <p>{i18n.t(`projectAgent.task.coordination.${key}`)}</p>
    {related && onSelect ? <button type="button" className="bot-task-conversation" onClick={()=>onSelect(related)}>
      {related===facts.replacementSessionId ? i18n.t('projectAgent.task.coordination.replacement',{title:facts.replacementTitle || i18n.t('projectAgent.drawer.replacement')}) : i18n.t('projectAgent.task.coordination.prior')}
      <PeerIcon name="arrowUpRight" size={13} />
    </button> : null}
  </section>;
}
