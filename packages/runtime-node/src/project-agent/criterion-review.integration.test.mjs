import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { evaluateVerificationGate } from '../goal-runner.mjs';
import { criterionSourceRevision } from './criterion-review.mjs';

test('host semantic review completes ordinary report without a manual signature; source changes invalidate it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'r88-review-'));
  try {
    const store = createGoalPlanStore({ storeDir: root });
    const plan = store.createGoalContract({ conversationId: 'c', goal: 'Read project',
      successCriteria: [{ id: 'report', kind: 'model_review', description: 'Covers all four questions' }],
      tasks: [{ taskId: 'read', description: 'Read files', status: 'completed', result: 'Four findings', evidenceRefs: ['e1'] }] });
    store.recordEvidenceRefs({ planId: plan.planId, conversationId: 'c', evidenceRefs: ['e1'] });
    const options = { indexedEvidenceRefs: new Set(['e1']), requireManualConfirmation: true };
    assert.equal(evaluateVerificationGate(plan, options).unmet[0].kind, 'model_review');
    assert.throws(() => store.recordCriterionResults(plan.planId, [{ criterionId: 'report', passed: true, evidenceRef: 'e1' }]), /host_verifier/);
    const sourceRevision = criterionSourceRevision(plan);
    assert.throws(() => store.recordModelReviews(plan.planId, { sourceRevision, verifierRunId: 'fake', passed: true, evidenceRefs: ['e1'] }), /host_verifier/);
    store.recordVerifierRun(plan.planId, { verifierRunId: 'actual', target: { kind: 'plan' }, status: 'passed', evidenceRefs: ['e1'], report: { passed: true } });
    store.recordModelReviews(plan.planId, { sourceRevision, verifierRunId: 'actual', passed: true, evidenceRefs: ['e1'] });
    assert.equal(evaluateVerificationGate(store.getPlan(plan.planId), options).passed, true);
    const saved = createGoalPlanStore({ storeDir: root }).getPlan(plan.planId);
    assert.equal(evaluateVerificationGate(saved, options).passed, true);
    store.revisePlan(plan.planId, { goal: 'A different question' });
    assert.equal(evaluateVerificationGate(store.getPlan(plan.planId), options).passed, false);
    assert.throws(() => store.recordModelReviews(plan.planId, { sourceRevision, verifierRunId: 'actual', passed: true, evidenceRefs: ['e1'] }), /source_changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('production Goal Runner performs one semantic review and clears old manual blocking without a worker rerun', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'r88-runner-review-'));
  try {
    const { createGoalRunner } = await import('../goal-runner.mjs');
    const store = createGoalPlanStore({ storeDir: root });
    const plan = store.createGoalContract({ conversationId:'runner-c',status:'completed',goal:'Read project',
      successCriteria:[{id:'quality',kind:'model_review',description:'Report answers four questions'}],
      tasks:[{taskId:'read',title:'Read files',status:'completed',result:'Four verified findings',evidenceRefs:['e1']}] });
    store.recordEvidenceRefs({planId:plan.planId,conversationId:'runner-c',evidenceRefs:['e1']});
    store.setRunnerState(plan.planId,{enabled:true,status:'blocked',intent:'verify',blockedReason:'manual_dod_confirmation_required'});
    let reviewed=0;
    const runner=createGoalRunner({goalPlanStore:store,logger:{warn(){}},
      chatRuntime:{runGoalTurn:()=>assert.fail('must reuse existing report')},
      verifierRunner:{runVerifier:async()=>{reviewed++;return{passed:true,evidenceRefs:['e1'],failedCriteria:[],missingEvidence:[]};}}});
    await runner.start(plan.planId,{awaitIdle:true});
    const saved=store.getPlan(plan.planId);
    assert.equal(saved.runner.status,'completed');assert.equal(saved.modelReviews[0].passed,true);
    assert.equal(saved.manualConfirmations.length,0);
    await runner.start(plan.planId,{awaitIdle:true});assert.equal(reviewed,1);
  } finally {rmSync(root,{recursive:true,force:true});}
});
