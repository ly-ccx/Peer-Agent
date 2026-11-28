// Real Node/Bun Store <-> native Store. Only synthetic, owned data is used.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createConversationStore} from '../../packages/conversation-store/src/index.mjs';
const root=mkdtempSync(join(tmpdir(),'peer-context-interop-'));writeFileSync(join(root,'.native-cli-fixture'),'isolated');
const binary=resolve('target/debug/examples/durable-conformance');
const call=(input)=>{const r=spawnSync(binary,[],{env:{...process.env,PEER_NATIVE_CONFORMANCE_ROOT:root},input:JSON.stringify(input),encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
const native=input=>{const r=call(input);assert.equal(r.ok,true,JSON.stringify(r));return r.data;};
let cases=0;
try{
 const store=createConversationStore({storeDir:join(root,'conversations')});
 const id=native({op:'create'}).id;
 store.updateModelEffort(id,{modelProviderId:'provider',model:'model'});
 store.appendMessage(id,{id:'u',role:'user',content:'assigned work'});
 const snapshot={version:1,conversationId:id,contentRevision:1,modelKey:'provider::model',revision:5,phase:'turn_complete',compactionEpoch:0,contextWindow:1000,inputBudget:1000,compactionThresholdTokens:800,authoritativeInputTokens:20,percent:2,pressureSource:'provider_usage',pendingUncountedChanges:false,pendingContentChars:0,countCapability:{kind:'observed_usage_only'},counterStatus:'active',updatedAt:1,lastObserved:{inputTokens:20,requestFingerprint:'observed-request',compactionEpoch:0,source:'provider_usage',observedAt:1},futureOpaque:{preserved:true}};
 assert.ok(store.updateContextSnapshot(id,snapshot));
 let raw=native({op:'context_read',id});assert.deepEqual(raw,store.getConversation(id).contextSnapshot);cases++;
 assert.equal(native({op:'context_read',id,modelKey:'other::model'}),null);cases++;
 native({op:'context_write',id,snapshot:{...snapshot,revision:6,authoritativeInputTokens:25,lastObserved:{...snapshot.lastObserved,inputTokens:25}}});
 assert.equal(store.getConversation(id).contextSnapshot.authoritativeInputTokens,25);assert.deepEqual(store.getConversation(id).contextSnapshot.futureOpaque,{preserved:true});cases++;
 const sidecar=join(root,'conversations/.context-snapshots',id+'.json');
 const valid=readFileSync(sidecar);
 for(const content of ['{broken',JSON.stringify({version:99,opaque:'keep'})]){
  writeFileSync(sidecar,content);assert.equal(native({op:'context_read',id}),null);assert.equal(store.updateContextSnapshot(id,snapshot),null);
  assert.equal(call({op:'context_write',id,snapshot}).code,'CONTEXT_SNAPSHOT_INVALID');assert.equal(readFileSync(sidecar,'utf8'),content);cases++;
 }
 writeFileSync(sidecar,valid);
 const selection={version:1,compactionEpoch:1,retainedMessageIds:['u']};
 const marker={id:'compact',role:'user',content:'handoff',_compaction:{summary:'handoff',historySelection:selection}};
 // Actual body-before-index partial commit: old numeric authority must vanish.
 assert.equal(call({op:'interrupt',id,message:marker}).code,'STORE_COMMIT_UNCERTAIN');
 const body=join(root,'conversations',id+'.jsonl'),preserved=readFileSync(body);
 assert.equal(native({op:'context_read',id}),null);assert.equal(store.getConversation(id).contextSnapshot.authoritativeInputTokens,null);assert.equal(store.getConversation(id).contextSnapshot.compactionEpoch,1);cases++;
 assert.equal(store.updateContextSnapshot(id,snapshot),null);cases++;
 native({op:'reconcile',id});assert.deepEqual(readFileSync(body),preserved);cases++;
 const post={...snapshot,contentRevision:2,compactionEpoch:1,revision:7,phase:'post_compaction',authoritativeInputTokens:null,percent:null,pressureSource:'unknown',pendingUncountedChanges:true,lastObserved:{...snapshot.lastObserved,supersededByCompactionRevision:1}};
 native({op:'context_write',id,snapshot:post});raw=store.getConversation(id).contextSnapshot;assert.equal(raw.compactionBoundaryId,'compact');assert.equal(raw.authoritativeInputTokens,null);cases++;
 store.appendMessage(id,{id:'later',role:'user',content:'later task'});
 assert.equal(store.getConversation(id).contextSnapshot,null);assert.equal(store.getLatestContextObservation(id,{modelKey:'provider::model'}),null);cases++;
 assert.ok(store.updateContextSnapshot(id,{...post,revision:8,phase:'restored',lastObserved:undefined}));assert.equal(native({op:'context_read',id}).compactionEpoch,1);cases++;
 console.log(`${cases} ${process.versions.bun?'Bun':'Node'} / Rust capacity storage, partial commit, corruption and recovery cases passed.`);
}catch(error){console.error(`Preserved failing owned fixture: ${root}`);throw error;}
rmSync(root,{recursive:true,force:true});
