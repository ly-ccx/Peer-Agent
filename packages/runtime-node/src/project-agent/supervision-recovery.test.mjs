import test from 'node:test';
import assert from 'node:assert/strict';
import { supervisionRecovery, transitionReconciliation } from './supervision-recovery.mjs';

const base=()=>({plan:{status:'completed',runner:{status:'completed'},delegationOrigin:{phase:'running',coordinationBinding:{executionEpoch:'e'}}},
 session:{sessionId:'s',planId:'p',followUp:{owner:'bot'}},work:{state:'delivered'},mandate:{goalRevision:3}});
test('returned result repair, human gate, legacy adoption and unknown effects have distinct native next steps',()=>{
 const f=base(); assert.equal(supervisionRecovery(f).nextAction,'coordinate_resume');
 assert.equal(supervisionRecovery({...f,session:{...f.session,followUp:{owner:'user'}}}).nextAction,'native_user_decision');
 assert.equal(supervisionRecovery({...f,mandate:null}).nextAction,'adopt_with_current_user');
 const unknown=supervisionRecovery({...f,receipts:[{effect:'unknown',operationId:'cmd'}]});
 assert.equal(unknown.replayAllowed,false); assert.deepEqual(unknown.blockers,['cmd']);
 const answered=supervisionRecovery({...f,requests:[{status:'open',responder:'parent',requestId:'q',revision:2}]});
 assert.equal(answered.nextAction,'answer_agent_request'); assert.equal(answered.expectedRequestRevision,2);
 assert.equal(supervisionRecovery({...f,receipts:[{effect:'pending',operationId:'queued'}]}).nextAction,'observe_current_attempt');
});
test('only a fresh host reconciliation record can reopen an unknown transition',()=>{
 const transition={phase:'awaiting_outcome',action:'resume',updatedAt:'2026-10-29T00:00:00Z'};
 const work={budget:{reconciledDispatches:[{planId:'p',attemptId:'attempt',toolCallId:'call',outcome:'verification_interrupted',at:'2026-10-29T00:00:01Z'}]}};
 assert.equal(transitionReconciliation(transition,{}, {planId:'p'}),null);
 assert.deepEqual(transitionReconciliation(transition,work,{planId:'p'}),{phase:'stopping',error:undefined,reconciliationRef:'attempt:call'});
 assert.equal(transitionReconciliation(transition,work,{planId:'other'}),null);
 work.budget.uncertainDispatches=[{toolCallId:'unresolved'}];
 assert.equal(transitionReconciliation(transition,work,{planId:'p'}),null);
});

test('the original settled stop proof can recover a false unknown takeover, never a different execution or control', () => {
  const execution = { planId: 'p', sessionId: 's', executionEpoch: 'old', goalRevision: 1 };
  const transition = { operationId: 'takeover', expectedGoalRevision: 1, phase: 'awaiting_outcome', action: 'resume' };
  const work = { workspaceId: 'w', parentConversationId: 'parent' };
  const control = { kind: 'takeover', operationId: 'takeover', workspaceId: 'w', parentConversationId: 'parent',
    phase: 'settled', outcome: 'applied', expectedExecution: execution,
    stopReceipt: { operationId: 'takeover', receiptId: 'stop:takeover', execution, scope: 'managed_execution',
      admissionClosed: true, runnerIdle: true, schedulerIdle: true, unknownCalls: [], completedAt: '2026-11-03T02:03:31Z' } };
  const session = { planId: 'p', origin: { sessionId: 's', coordinationBinding: { executionEpoch: 'old', goalRevision: 1 },
    takeover: { operationId: 'takeover', phase: 'stopping' }, executionControl: control } };
  assert.deepEqual(transitionReconciliation(transition, work, session), { phase: 'stopping', error: undefined, reconciliationRef: 'stop:takeover' });
  for (const patch of [{ operationId: 'new-control' }, { phase: 'reconciling' }, { outcome: 'rejected' },
    { workspaceId: 'other' }, { parentConversationId: 'other' }, { expectedExecution: { ...execution, generation: 'new' } },
    { stopReceipt: { ...control.stopReceipt, unknownCalls: ['real-shell'] } },
    { stopReceipt: { ...control.stopReceipt, runnerIdle: false } },
    { stopReceipt: { ...control.stopReceipt, execution: { ...execution, goalRevision: 2 } } }]) {
    assert.equal(transitionReconciliation(transition, work, { ...session, origin: { ...session.origin, executionControl: { ...control, ...patch } } }), null);
  }
  assert.equal(transitionReconciliation(transition, { ...work, budget: { uncertainDispatches: [{ toolCallId: 'unknown' }] } }, session), null);
  assert.equal(transitionReconciliation({ ...transition, expectedGoalRevision: 2 }, work, session), null);
  assert.equal(transitionReconciliation(transition, work, { ...session, origin: { ...session.origin, executionGeneration: 'new-resume' } }), null);
  for (const origin of [undefined, {}, { takeover: {} }, { takeover: { phase: 'stopping' } }]) {
    assert.equal(transitionReconciliation({ ...transition, operationId: undefined }, work, { ...session, origin }), null,
      'missing legacy identities must not compare equal and enter current stop-proof recovery');
  }
});
