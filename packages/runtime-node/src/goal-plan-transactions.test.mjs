import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,mkdirSync,readFileSync,existsSync,rmdirSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGoalPlanStore } from './goal-plan-store.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('Goal mutators share index root lock and callbacks re-enter after release',t=>{
 const root=mkdtempSync(join(tmpdir(),'peer-goal-root-lock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const second=createGoalPlanStore({storeDir:root});let callbacks=0;
 const first=createGoalPlanStore({storeDir:root,onChange:event=>{
   assert.equal(existsSync(join(root,'index.jsonl.lock')),false);
   callbacks++;if(callbacks===1)second.revisePlan(event.planId,{goal:'revised after unlock'});
 }});
 const plan=first.createPlan({title:'synthetic',goal:'initial'});
 assert.equal(second.getPlan(plan.planId).goal,'revised after unlock');assert.equal(callbacks,1);
 const body=readFileSync(join(root,`${plan.planId}.json`));const index=readFileSync(join(root,'index.jsonl'));
 mkdirSync(join(root,'index.jsonl.lock'));
 for(const operation of [()=>first.revisePlan(plan.planId,{goal:'blocked'}),()=>first.deletePlan(plan.planId),()=>first.setRunnerState(plan.planId,{turnCount:1}),()=>first.createPlan({goal:'blocked'})]){
  assert.throws(operation,{code:'STORE_LOCK_BUSY'});
  assert.deepEqual(readFileSync(join(root,`${plan.planId}.json`)),body);assert.deepEqual(readFileSync(join(root,'index.jsonl')),index);
 }
 rmdirSync(join(root,'index.jsonl.lock'));first.revisePlan(plan.planId,{goal:'next admitted'});
 assert.equal(second.getPlan(plan.planId).goal,'next admitted');
});
test('runner progress timer retains overlay on root contention and later persists',async t=>{
 const root=mkdtempSync(join(tmpdir(),'peer-goal-progress-lock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=createGoalPlanStore({storeDir:root,runnerProgressFullRewriteBytes:0});
 const plan=store.createPlan({title:'synthetic',goal:'progress',status:'accepted',runner:{enabled:true,status:'running',turnCount:0}});
 store.setRunnerState(plan.planId,{turnCount:1});
 const lock=join(root,'index.jsonl.lock');mkdirSync(lock);
 await delay(1250);assert.equal(store.getPlan(plan.planId).runner.turnCount,1);
 rmdirSync(lock);await delay(1200);
 const patch=JSON.parse(readFileSync(join(root,'runner-progress',`${plan.planId}.json`),'utf8'));
 assert.equal(patch.runner.turnCount,1);store.deletePlan(plan.planId);
});
