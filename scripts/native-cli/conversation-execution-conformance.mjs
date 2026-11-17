// Development interop only. The product never starts Node/Bun as an engine.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createConversationStore} from '../../packages/conversation-store/src/index.mjs';
import {normalizeConversationExecution} from '../../packages/protocol/dist/conversation-execution.js';
const binary=resolve(process.argv[2]??'target/debug/examples/conversation-execution-conformance');
const evidence=resolve(process.argv[3]??mkdtempSync(join(tmpdir(),'peer-ordinary-execution-interop-')));mkdirSync(evidence,{recursive:true});
let cases=0;
function world(name){const root=mkdtempSync(join(evidence,'case-'));writeFileSync(join(root,'.native-cli-fixture'),'isolated');
 const store=createConversationStore({storeDir:join(root,'conversations')});const c=store.createConversation({title:name,mode:'chat'});
 store.appendMessage(c.id,{id:'user',role:'user',content:'actual TS writer',future:{keep:true}});
 appendFileSync(join(evidence,'roots.jsonl'),JSON.stringify({name,root,id:c.id})+'\n');return{root,store,id:c.id,index:join(root,'conversations/index.jsonl')};}
function native(w,request){const r=spawnSync(binary,[],{input:JSON.stringify({id:w.id,...request}),encoding:'utf8',timeout:10000,env:{PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:w.root}});
 assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
{
 const w=world('native owner -> real TS metadata rewrite -> native blocked claim');
 const owned=native(w,{op:'claim',stream:'native-stream'});assert.equal(owned.ok,true);normalizeConversationExecution(owned.run);
 assert.deepEqual(w.store.getConversation(w.id).runtimeExecution,owned.run);
 w.store.updateTitle(w.id,'actual TS metadata update');
 const cold=createConversationStore({storeDir:join(w.root,'conversations')});assert.deepEqual(cold.getConversation(w.id).runtimeExecution,owned.run);
 assert.deepEqual(native(w,{op:'read'}).run,owned.run);
 assert.equal(native(w,{op:'claim',stream:'replacement'}).code,'conversation_execution_busy');cases+=4;
}
for(const unknown of [false,true]){
 const w=world('TS serialized owner -> native strict decoder');const fixture=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/conversation-execution.json',import.meta.url),'utf8'));
 const run=structuredClone(fixture.cases.find(c=>c.name==='ts-owner').input);run.identity.conversationId=w.id;
 if(unknown)run.schemaVersion=2;else normalizeConversationExecution(run);
 const rows=readFileSync(w.index,'utf8').trim().split('\n').map(JSON.parse);rows[0].runtimeExecution=run;rows[0].futureMetadata={keep:true};writeFileSync(w.index,rows.map(JSON.stringify).join('\n')+'\n');
 // This is a raw serialization fixture, not a claimed TS production owner API.
 w.store.updateTitle(w.id,'TS preserves opaque execution');
 const before=readFileSync(w.index,'utf8');const result=native(w,{op:'read'});
 if(unknown)assert.equal(result.code,'conversation_execution_invalid');else assert.deepEqual(result.run,run);
 assert.equal(native(w,{op:'claim',stream:'replacement'}).code,unknown?'conversation_execution_invalid':'conversation_execution_busy');
 assert.equal(readFileSync(w.index,'utf8'),before);assert.deepEqual(JSON.parse(before).futureMetadata,{keep:true});cases+=4;
}
writeFileSync(join(evidence,'result.json'),JSON.stringify({cases,limits:'Store/decoder interoperability only; no TS production execution guard, owner-death reconciliation, ordinary CLI send, ACP or P4 total claim.'},null,2)+'\n');
console.log(`${cases} real TS Store/native decoder and owner-preservation checks passed (${evidence}).`);
