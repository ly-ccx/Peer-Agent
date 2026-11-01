import type { I18nRuntime } from '@peer-agent/i18n';
import type { DrawerSession } from '../state/drawerState';
import { PeerIcon } from '../../ui/icons';

/** Renders host receipts and task relationships; it never drives a transition. */
export function CoordinationDetails({session,i18n,onSelect}: {readonly session:DrawerSession;readonly i18n:I18nRuntime;readonly onSelect?:(id:string)=>void}) {
  const facts=session.coordination?.action==='parallel' ? undefined : session.coordination;
  const unknownCount=session.withdrawalUnknownCallIds?.length || 0;
  const blocker = session.resourceBlocker;
  if (!facts && !unknownCount && !blocker) return null;
  const key=facts?.phase==='awaiting_outcome' ? 'unknown' : facts?.phase==='blocked' ? 'blocked' : facts?.phase==='completed' ? 'applied' : 'pending';
  const executionKey = facts?.executionEffect === 'unknown' ? 'unknown' : facts?.executionEffect === 'rejected' || facts?.executionAdmission === 'rejected' ? 'blocked'
    : facts?.executionEffect === 'applied' ? 'executionObserved' : facts?.executionAdmission ? 'executionQueued' : null;
  const related=facts?.replacementSessionId && facts.replacementSessionId!==session.sessionId ? facts.replacementSessionId
    : facts?.priorSessionId!==session.sessionId ? facts?.priorSessionId : undefined;
  return <section className="bot-task-instructions bot-task-adjustment" aria-label={i18n.t('projectAgent.task.coordination.heading')}>
    <h3>{i18n.t('projectAgent.task.coordination.heading')}</h3>
    {unknownCount > 0 ? <p>{i18n.t('projectAgent.task.coordination.withdrawnUnknown',{count:unknownCount})}</p> : null}
    {facts ? <><p>{facts.reason}</p><p>{i18n.t(`projectAgent.task.coordination.${executionKey || key}`)}</p></> : null}
    {blocker ? <>
      <p>{i18n.t(blocker.kind === 'protection' ? blocker.code === 'execution_outcome_unknown'
        ? 'projectAgent.drawer.resourceOutcomeUnknown' : 'projectAgent.drawer.resourceStopUnconfirmed'
        : blocker.kind === 'recovery' ? 'projectAgent.drawer.resourceRecovery' : 'projectAgent.drawer.resourceBusy')}</p>
      {blocker.resourceRef ? <dl><div><dt>{i18n.t('projectAgent.drawer.resourceScope')}</dt><dd>{blocker.resourceRef.replace(/^directory:/, '')}</dd></div></dl> : null}
      {blocker.kind !== 'recovery' && blocker.sessionId && blocker.sessionId !== session.sessionId && onSelect
        ? <button type="button" className="bot-task-conversation" onClick={() => onSelect(blocker.sessionId!)}>
          {i18n.t('projectAgent.drawer.resourceSource')}<PeerIcon name="arrowUpRight" size={13} />
        </button> : null}
    </> : null}
    {related && onSelect && facts ? <button type="button" className="bot-task-conversation" onClick={()=>onSelect(related)}>
      {related===facts.replacementSessionId ? i18n.t('projectAgent.task.coordination.replacement',{title:facts.replacementTitle || i18n.t('projectAgent.drawer.replacement')}) : i18n.t('projectAgent.task.coordination.prior')}
      <PeerIcon name="arrowUpRight" size={13} />
    </button> : null}
  </section>;
}
