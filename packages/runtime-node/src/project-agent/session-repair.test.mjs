import test from 'node:test';
import assert from 'node:assert/strict';
import { takeoverBlocker } from './session-repair.mjs';
import { criterionSourceRevision, currentModelReview } from './criterion-review.mjs';
import { verificationContentHash } from './verification-completion.mjs';

test('a returned unaccepted task can resume while acceptance, user stop and human gates remain protected', () => {
  const plan = {status:'completed',delegationOrigin:{phase:'running'},runner:{status:'completed'}};
  assert.equal(takeoverBlocker(plan,'resume'),null);
  assert.equal(takeoverBlocker(plan,'handoff'),'session_not_running');
  assert.equal(takeoverBlocker({...plan,resultAcceptance:{acceptedAt:'now'}},'resume'),'session_not_running');
  assert.equal(takeoverBlocker({...plan,status:'cancelled'},'resume'),'session_not_running');
  assert.equal(takeoverBlocker({...plan,runner:{status:'waiting_user',waitingOnUser:true}},'resume'),'human_decision_required');
});

test('repair execution invalidates prior semantic review without deleting its evidence or history', () => {
  const plan={planId:'p',goal:'same goal',tasks:[],delegationOrigin:{}};
  const sourceRevision=criterionSourceRevision(plan);
  plan.modelReviews=[{criterionId:'quality',sourceRevision,passed:true,evidenceRefs:['e1']}];
  assert.equal(currentModelReview(plan,'quality').passed,true);
  const repaired={...plan,delegationOrigin:{takeover:{repair:true,binding:{executionEpoch:'new'}}}};
  assert.equal(currentModelReview(repaired,'quality'),null);
  assert.notEqual(verificationContentHash(repaired,'same report'),verificationContentHash(plan,'same report'));
  assert.equal(repaired.modelReviews[0].passed,true);
  assert.deepEqual(repaired.modelReviews[0].evidenceRefs,['e1']);
});
