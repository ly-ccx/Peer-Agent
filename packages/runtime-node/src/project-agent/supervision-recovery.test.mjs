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
