import test from 'node:test';
import assert from 'node:assert/strict';
import { beginVerificationAttempt, sessionFactsFromPlan } from './session-facts.mjs';

test('stale verifying flags cannot hide a blocker or survive verifier termination', () => {
  const plan = { planId: 'p', status: 'executing', delegationOrigin: { phase: 'running', verifying: true }, runner: { status: 'blocked', blockedReason: 'verifier_failed' } };
  assert.equal(sessionFactsFromPlan(plan).status, 'waiting_user');
  const end = beginVerificationAttempt('p', 'a');
  assert.equal(sessionFactsFromPlan(plan).status, 'waiting_user');
  plan.runner.status = 'running';
  assert.equal(sessionFactsFromPlan(plan).status, 'verifying');
  end();
  assert.equal(sessionFactsFromPlan(plan).status, 'running');
});
test('current terminal and human facts win over active verification', () => {
  const end = beginVerificationAttempt('p2', 'a');
  const plan = { planId: 'p2', status: 'completed', delegationOrigin: {}, resultAcceptance: { acceptedAt: 'now' } };
  assert.equal(sessionFactsFromPlan(plan).status, 'accepted');
  delete plan.resultAcceptance; plan.status = 'cancelled';
  assert.equal(sessionFactsFromPlan(plan).status, 'cancelled');
  end();
});

test('completed worker evidence does not announce a result while its runner is still verifying it', async () => {
  const { watchFactsFromPlan } = await import('./watchdog.mjs');
  const plan = { planId: 'race', status: 'completed', delegationOrigin: { sessionId: 's', phase: 'running' },
    tasks: [{ taskId: 'read', status: 'completed', result: 'Read complete', evidenceRefs: ['e'] }], runner: { status: 'running' } };
  assert.equal(sessionFactsFromPlan(plan).status, 'running');
  assert.equal(watchFactsFromPlan(plan).reportRevision, undefined);
  const end = beginVerificationAttempt('race', 'verifier');
  assert.equal(sessionFactsFromPlan(plan).status, 'verifying');
  assert.equal(watchFactsFromPlan(plan).reportRevision, undefined);
  end(); plan.runner.status = 'completed';
  assert.equal(sessionFactsFromPlan(plan).status, 'result_ready');
  assert.ok(watchFactsFromPlan(plan).reportRevision);
});

test('overlapping verification attempts retain their own lifetime even behind a blocker', async () => {
  const { watchFactsFromPlan } = await import('./watchdog.mjs');
  const plan = { planId:'overlap',status:'completed',delegationOrigin:{sessionId:'s'},
    runner:{status:'blocked'},tasks:[{taskId:'read',status:'completed',result:'report'}] };
  const endA=beginVerificationAttempt(plan.planId,'a'),endB=beginVerificationAttempt(plan.planId,'b');
  endB();
  assert.equal(sessionFactsFromPlan(plan).status,'waiting_user');
  assert.equal(sessionFactsFromPlan(plan).verificationActive,true);
  assert.equal(watchFactsFromPlan(plan).reportRevision,undefined);
  endA();assert.equal(sessionFactsFromPlan(plan).verificationActive,false);
});

test('real store leaf writes preserve the delegated pump until its verifier ends', async () => {
  const { mkdtempSync,rmSync }=await import('node:fs');
  const { tmpdir }=await import('node:os');
  const { join }=await import('node:path');
  const { createGoalPlanStore }=await import('../goal-plan-store.mjs');
  const { watchFactsFromPlan }=await import('./watchdog.mjs');
  const root=mkdtempSync(join(tmpdir(),'r88-store-handoff-'));
  try {
    const store=createGoalPlanStore({storeDir:root});
    const model={providerId:'p',modelId:'m',modelProviderId:'m',family:'openai'};
    const plan=store.createGoalContract({conversationId:'child',goal:'Read project',
      successCriteria:[{id:'quality',kind:'model_review',description:'Check findings'}],
      delegationOrigin:{sessionId:'s',workspaceId:'w',readOnly:true,phase:'running',anchorMessageId:'input-i',inputId:'i',
        modelSelection:{worker:model,explorer:model,verifier:model,source:{worker:'global'},resolvedAt:'2026-10-07T00:00:00Z'}},
      tasks:[{taskId:'read',title:'Read',status:'pending',evidenceRefs:[]}]});
    store.setPlanStatus(plan.planId,'executing');
    store.setRunnerState(plan.planId,{enabled:true,status:'running',intent:'execute',phase:'act'});
    store.recordEvidenceRefs({planId:plan.planId,conversationId:'child',toolCallId:'read',toolName:'read_file',evidenceRefs:['ev-read']});
    store.recordTaskEvidence(plan.planId,'read',{status:'completed',result:'Finding',evidenceRefs:['ev-read']});
    const written=store.getPlan(plan.planId);
    assert.equal(written.status,'completed');assert.equal(written.runner.status,'running');
    assert.equal(watchFactsFromPlan(written).reportRevision,undefined);
    store.setRunnerState(plan.planId,{status:'running',intent:'verify',phase:'verify'});
    assert.equal(watchFactsFromPlan(store.getPlan(plan.planId)).reportRevision,undefined);
    store.setRunnerState(plan.planId,{status:'completed',enabled:false});
    assert.ok(watchFactsFromPlan(store.getPlan(plan.planId)).reportRevision);
  } finally {rmSync(root,{recursive:true,force:true});}
});
