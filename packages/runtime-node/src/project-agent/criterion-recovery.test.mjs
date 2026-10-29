import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createLegacyCriterionRecovery } from './criterion-recovery.mjs';
test('explicit audited legacy repair preserves real manual decisions, history and no-memory intent', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'r88-repair-'));
  try {
    const store = createGoalPlanStore({ storeDir: root });
    const plan = store.createGoalContract({ conversationId: 'c', goal: 'Read project; do not write memory',
      successCriteria: [{id:'c4',kind:'manual',description:'Git check'}, {id:'c5',kind:'manual',description:'Report quality'}],
      delegationOrigin: { sessionId:'s',workspaceId:'w',parentConversationId:'parent',anchorMessageId:'u',inputId:'i',modelSelection:{worker:{providerId:'p',modelId:'m',modelProviderId:'m',family:'f'},explorer:{providerId:'p',modelId:'m',modelProviderId:'m',family:'f'},verifier:{providerId:'p',modelId:'m',modelProviderId:'m',family:'f',sameFamilyAsWorker:true},source:{worker:'global'},resolvedAt:'2026-10-07T00:00:00Z'},readOnly:true,phase:'running' }, tasks: [] });
    const proof = { planId:plan.planId, noManualReviewPolicy:true,userReviewRequested:false,dispatchEvidenceRef:'dispatch-evidence',modelCriteria:plan.successCriteria };
    let owns = false;
    const recovery = createLegacyCriterionRecovery({store,readProvenance:()=>proof,holdsLease:()=>owns});
    const audit = recovery.audit(plan.planId,['c4','c5']); assert.equal(audit.ok,true);
    assert.throws(()=>recovery.apply(audit), /lease_required/); owns=true;
    const changed = recovery.apply(audit);
    assert.equal(changed.successCriteria.every(row=>row.kind==='model_review'),true);
    assert.equal(changed.manualConfirmations.length,0); assert.equal(changed.goal,plan.goal);
    assert.ok(changed.revisions?.length || changed.revisionHistory?.length || changed.revision > plan.revision);
    assert.equal(recovery.audit(plan.planId,['c4']).ok,false);
    const manual = store.createGoalContract({conversationId:'c2',goal:'Human review',successCriteria:[{id:'human',kind:'manual',description:'Human review'}],delegationOrigin:plan.delegationOrigin,tasks:[]});
    store.recordManualConfirmation(manual.planId, {decision:'reject',criterionIds:['human'],confirmedBy:'user'});
    const rejected = createLegacyCriterionRecovery({store,holdsLease:()=>true,readProvenance:p=>({...proof,planId:p.planId,modelCriteria:p.successCriteria})});
    assert.equal(rejected.audit(manual.planId,['human']).ok,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
