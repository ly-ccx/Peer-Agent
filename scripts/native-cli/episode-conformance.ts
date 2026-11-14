// Cold-read the public native executable's real synthetic stores using the
// current TS implementations. This development process is never a CLI sidecar.
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createGoalPlanStore} from '../../packages/runtime-node/src/goal-plan-store.mjs';
import {createCoordinationStorageV2} from '../../packages/runtime-node/src/project-agent/coordination-storage-v2.mjs';
import {createConversationStore} from '../../packages/conversation-store/src/index.mjs';
import {projectConversationHistory} from '../../packages/runtime-core/src/conversation-history-projector.ts';
const output=resolve(process.argv[2]);assert.ok(existsSync(join(output,'.native-cli-fixture')));const roots=readFileSync(join(output,'roots.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));let cases=0;
for(const receipt of roots){const root=receipt.root;assert.ok(existsSync(join(root,'.native-cli-fixture')));const plans=createGoalPlanStore({storeDir:join(root,'goal-plans')});const conversations=createConversationStore({storeDir:join(root,'conversations')});
 const storage=createCoordinationStorageV2({directory:join(root,'project-runtime/w'),legacyFile:join(root,'project-runtime/w/coordination.jsonl'),assertOwner(){}});
 try{await storage.prepare();const state=storage.read();const raw=JSON.parse(readFileSync(join(root,'goal-plans/p.json'),'utf8'));const plan=plans.getPlan('p');assert.equal(plan.planId,raw.planId);assert.equal(plan.delegationOrigin.executionControl?.phase,raw.delegationOrigin.executionControl?.phase);assert.deepEqual(plan.future,{opaque:'preserved'});cases++;
 const history=conversations.getPersistedConversationHistory('c');const projected=projectConversationHistory(history.messages);for(const message of projected.messages.filter(m=>m.role==='tool')){assert.ok(projected.messages.some(m=>m.toolCalls?.some(c=>c.id===message.toolCallId)));}cases++;
 for(const work of Object.values(state.works) as any[]){for(const pending of [...(work.budget?.uncertainDispatches||[]),...Object.values(work.budget?.attempts||{}).flatMap((a:any)=>a.pendingTools||[])]){assert.equal(pending.nativeRecorder.schemaVersion,1);assert.equal(pending.nativeRecorder.runtime,'peer-native');assert.ok(pending.dispatchId.startsWith('dispatch-'));assert.equal(pending.nativeRecorder.execution.planId,pending.planId||'p');cases++;}}
 if(receipt.case?.includes('crash_after_file')){assert.equal(state.works.work.budget.uncertainDispatches.length,1);assert.equal(state.works.work.budget.attempts && Object.keys(state.works.work.budget.attempts).length,0);assert.equal(plan.delegationOrigin.executionControl.phase,'reconciling');assert.equal(state.works.work2.budget.toolCalls,1);assert.equal(plans.getPlan('p2').status,'paused');cases++;}
 }finally{storage.close();}
}
assert.ok(roots.length>=6);console.log(JSON.stringify({ok:true,roots:roots.length,cases,coverage:'Actual native exec -> current TS Goal/Conversation/canonical coordination, native recorder retention, pending/receipt history and later task; no model execution by TS.'}));
