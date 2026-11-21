import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
test('canonical Goal normalization and subsequent revisions retain a real closure mirror',t=>{
 const fixtures=JSON.parse(readFileSync(new URL('../../protocol/contracts/native-cli/goal-execution-facts.json',import.meta.url),'utf8'));
 const raw=fixtures.cases.find(c=>c.name==='policy resolution closure mirror').raw;
 const root=mkdtempSync(join(tmpdir(),'peer-goal-closure-mirror-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(root,{recursive:true});writeFileSync(join(root,'p.json'),JSON.stringify(raw));writeFileSync(join(root,'index.jsonl'),JSON.stringify({planId:'p',title:'fixture',conversationId:'c',status:raw.status})+'\n');
 const store=createGoalPlanStore({storeDir:root});const closure=raw.delegationOrigin.executionClaimClosure;
 assert.deepEqual(store.getPlan('p').delegationOrigin.executionClaimClosure,closure);
 store.revisePlan('p',{goal:'later user correction'});
 const reopened=createGoalPlanStore({storeDir:root}).getPlan('p');
 assert.deepEqual(reopened.delegationOrigin.executionClaimClosure,closure);
 assert.deepEqual(reopened.delegationOrigin.executionClaimClosure.unknownCalls,['unknown']);
 assert.equal(reopened.delegationOrigin.executionClaimClosure.future.keep,true);
});
