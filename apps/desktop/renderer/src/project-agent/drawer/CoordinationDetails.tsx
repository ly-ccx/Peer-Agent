import { useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { DrawerSession } from '../state/drawerState';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';

/** Renders host receipts and task relationships; it never drives a transition. */
export function CoordinationDetails({session,i18n,onSelect,workspaceId}: {readonly session:DrawerSession;readonly i18n:I18nRuntime;readonly onSelect?:(id:string)=>void;readonly workspaceId?:string}) {
  const [release, setRelease] = useState<'idle' | 'pending' | 'requested' | { error: string }>('idle');
  const facts=session.coordination?.action==='parallel' ? undefined : session.coordination;
  const unknownCount=session.withdrawalUnknownCallIds?.length || 0;
  const blocker = session.resourceBlocker;
  const closure = session.executionClaimClosure;
  const retainedUnknownCalls = session.retainedUnknownCalls || [];
  const canRequestRelease = Boolean(workspaceId && blocker?.kind === 'protection' && blocker.closeClaimAvailable === true
    && blocker.sessionId === session.sessionId && !closure);
  async function requestRelease() {
    if (!workspaceId || !canRequestRelease) return;
    setRelease('pending');
    try {
      const result = await clientApi.projectAgentRequestClaimClosure({ workspaceId, sessionId: session.sessionId });
      if (!result?.ok) { setRelease({ error: result?.code || result?.error || 'UNAVAILABLE' }); return; }
      setRelease('requested');
    } catch { setRelease({ error: 'UNAVAILABLE' }); }
  }
  if (!facts && !unknownCount && !blocker && !closure) return null;
  const key=facts?.phase==='awaiting_outcome' ? 'unknown' : facts?.phase==='blocked' ? 'blocked' : facts?.phase==='completed' ? 'applied' : 'pending';
  const executionKey = facts?.executionEffect === 'unknown' ? 'unknown' : facts?.executionEffect === 'rejected' || facts?.executionAdmission === 'rejected' ? 'blocked'
    : facts?.executionEffect === 'applied' ? 'executionObserved' : facts?.executionAdmission ? 'executionQueued' : null;
  const related=facts?.replacementSessionId && facts.replacementSessionId!==session.sessionId ? facts.replacementSessionId
    : facts?.priorSessionId!==session.sessionId ? facts?.priorSessionId : undefined;
  return <section className="bot-task-instructions bot-task-adjustment" aria-label={i18n.t('projectAgent.task.coordination.heading')}>
    <h3>{i18n.t('projectAgent.task.coordination.heading')}</h3>
    {unknownCount > 0 ? <p>{i18n.t('projectAgent.task.coordination.withdrawnUnknown',{count:unknownCount})}</p> : null}
    {closure ? <div className="bot-task-claim-closure">
      <p>{i18n.t('projectAgent.drawer.claimClosed')}</p>
      {retainedUnknownCalls.length ? <p>{i18n.t('projectAgent.drawer.claimClosedUnknown', { calls: retainedUnknownCalls.join(', ') })}</p> : null}
      <p>{i18n.t('projectAgent.drawer.claimClosedHint')}</p>
    </div> : null}
    {facts ? <><p>{facts.reason}</p><p>{i18n.t(`projectAgent.task.coordination.${executionKey || key}`)}</p></> : null}
    {blocker ? <>
      <p>{i18n.t(blocker.kind === 'protection' ? blocker.code === 'execution_outcome_unknown'
        ? 'projectAgent.drawer.resourceOutcomeUnknown' : 'projectAgent.drawer.resourceStopUnconfirmed'
        : blocker.kind === 'recovery' ? 'projectAgent.drawer.resourceRecovery' : 'projectAgent.drawer.resourceBusy')}</p>
      {blocker.resourceRef ? <dl><div><dt>{i18n.t(blocker.scope?.kind === 'file' ? 'projectAgent.drawer.resourceScopeFile' : 'projectAgent.drawer.resourceScope')}</dt><dd>{blocker.resourceRef.replace(/^(directory|file):/, '')}</dd></div></dl> : null}
      {blocker.kind !== 'recovery' && blocker.sessionId && blocker.sessionId !== session.sessionId && onSelect
        ? <button type="button" className="bot-task-conversation" onClick={() => onSelect(blocker.sessionId!)}>
          {i18n.t('projectAgent.drawer.resourceSource')}<PeerIcon name="arrowUpRight" size={13} />
        </button> : null}
      {canRequestRelease ? <div className="bot-task-claim-release">
        <button type="button" className="ui-button is-compact" disabled={release === 'pending'} onClick={() => { void requestRelease(); }}>
          {i18n.t('projectAgent.drawer.resourceReleaseAction')}
        </button>
        {release === 'requested' ? <p role="status">{i18n.t('projectAgent.drawer.resourceReleaseRequested')}</p> : null}
        {typeof release === 'object' ? <p role="alert">{i18n.t('projectAgent.drawer.resourceReleaseFailed')}<span className="bot-task-claim-release-code">{release.error}</span></p> : null}
      </div> : null}
    </> : null}
    {related && onSelect && facts ? <button type="button" className="bot-task-conversation" onClick={()=>onSelect(related)}>
      {related===facts.replacementSessionId ? i18n.t('projectAgent.task.coordination.replacement',{title:facts.replacementTitle || i18n.t('projectAgent.drawer.replacement')}) : i18n.t('projectAgent.task.coordination.prior')}
      <PeerIcon name="arrowUpRight" size={13} />
    </button> : null}
  </section>;
}
