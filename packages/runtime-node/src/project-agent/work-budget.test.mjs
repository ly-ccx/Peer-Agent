import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget, createWorkBudgetGuard } from './work-budget.mjs';

test('unknown child effects fence that executor while coordinator and unrelated child retain compute',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'scoped-work-budget-'));
  const store=createWorkCoordinationStore({rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'one'});
  store.saveWork({workId:'goal',state:'waiting_children'});
  const release=registerWorkBudget('w',store);
  const profile=planId=>({workspaceId:'w',workId:'goal',planId,role:planId?'work_session':'project_agent'});
  try{
    const a=createWorkBudgetGuard(profile('A')); a.beforeRequest(); a.beforeTool({toolCallId:'write',capabilityId:'local.file.write'}); a.finish({totalTokens:3,estimatedCostUsd:0});
    assert.equal(store.read().works.goal.budget.uncertainDispatches[0].planId,'A');
    assert.throws(()=>createWorkBudgetGuard(profile('A')).beforeRequest(),/execution_outcome_unknown/);
    const b=createWorkBudgetGuard(profile('B')), coordinator=createWorkBudgetGuard(profile());
    b.beforeRequest(); coordinator.beforeRequest();
    b.finish({totalTokens:2,estimatedCostUsd:0}); coordinator.finish({totalTokens:1,estimatedCostUsd:0});
    assert.equal(store.read().works.goal.budget.modelRequests,3);
    assert.equal(store.read().works.goal.budget.uncertainDispatches.length,1);
    store.saveWork({workId:'goal',state:'cancelled',stopScope:'work'});
    assert.throws(()=>createWorkBudgetGuard(profile('B')).beforeRequest(),/work_execution_stopped/);
  }finally{release();rmSync(root,{recursive:true,force:true});}
});
