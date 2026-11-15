import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmdirSync, cpSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../../packages/conversation-store/src/index.mjs';
import { appendAuxiliaryUsageRecord } from '../../packages/conversation-store/src/usage-ledger.mjs';
const binary=path.resolve(process.argv[2]??'target/debug/examples/usage-conformance');
const root=mkdtempSync(path.join(tmpdir(),'peer-native-ledger-conformance-'));let cases=0;
const base={usage:{usageScope:'runtime_turn',providerRequestCount:3,inputTokens:100,outputTokens:20,cacheReadTokens:7,cacheWriteTokens:4,totalTokens:99999},
  attribution:{id:'turn-one',at:'2026-11-15T00:00:00.000Z',streamId:'stream-one',modelProviderId:'channel::模型😀',groupId:'channel',model:'模型😀',providerName:'供应商',estimatedCostUsd:0.03,role:'work_session',workspaceId:'workspace'}};
function fixture(name){
 const home=path.join(root,name);mkdirSync(home);writeFileSync(path.join(home,'.native-cli-fixture'),'owned');
 const storeDir=path.join(home,'conversations'),ledger=path.join(home,'usage/requests.jsonl');mkdirSync(path.dirname(ledger));writeFileSync(ledger,'');
 const store=createConversationStore({storeDir});const meta=store.createConversation({title:name});
 return {root:home,id:meta.id,input:structuredClone(base),store,storeDir,ledger,intent:path.join(storeDir,'.usage-ledger-transaction')};
}
function native(f,env={}){const r=spawnSync(binary,{input:JSON.stringify(f),encoding:'utf8',env:{...process.env,PATH:'/nonexistent',...env}});if(r.status!==0)return {status:r.status};return JSON.parse(r.stdout.trim());}
function nodePeer(f){const r=spawnSync(process.execPath,['scripts/native-cli/usage-ledger-peer.mjs'],{input:JSON.stringify({root:f.root,id:f.id,input:f.input}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);}
function pending(f){chmodSync(f.ledger,0o400);try{assert.throws(()=>f.store.recordRuntimeTurnUsage(f.id,f.input),{code:'USAGE_LEDGER_COMMIT_UNCERTAIN'});}finally{chmodSync(f.ledger,0o600);}return JSON.parse(readFileSync(f.intent,'utf8'));}
function next(f,writer=native){const input=structuredClone(f.input);input.attribution.id+='-next';input.attribution.streamId+='-next';const r=writer({...f,input});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.value.lifetimeUsage.runtimeTurnCount,2);return r;}
function check(name,fn){fn();cases++;console.log(`ok ${name}`);}
check('actual TS -> Rust -> TS same identity and three usage scopes remain separate',()=>{
 const f=fixture('roundtrip');const ts=f.store.recordRuntimeTurnUsage(f.id,f.input);
 assert.deepEqual(native(f),{ok:true,value:ts});assert.deepEqual(nodePeer(f),{ok:true,value:ts});
 const rust=next(f);assert.deepEqual(nodePeer({...f,input:{...f.input,attribution:{...f.input.attribution,id:'turn-one-next',streamId:'stream-one-next'}}}),rust);
 assert.equal(rust.value.lifetimeUsage.inputTokens,200);assert.equal(rust.value.lifetimeUsage.totalTokens,262);
});
check('existing retry may omit optional attribution while preserving the original row',()=>{
 const f=fixture('retry-omitted'),first=f.store.recordRuntimeTurnUsage(f.id,f.input);
 f.input.attribution={id:'turn-one'};assert.deepEqual(native(f),{ok:true,value:first});assert.deepEqual(nodePeer(f),{ok:true,value:first});
});
for(const state of ['missing','partial','complete','auxiliary'])check(`real Node append failure -> native ${state} recovery -> Node cold duplicate and next turn`,()=>{
 const f=fixture(`node-${state}`),intent=pending(f);
 if(state==='partial')writeFileSync(f.ledger,Buffer.from(intent.ledgerLine).subarray(0,155));
 if(state==='complete')writeFileSync(f.ledger,intent.ledgerLine);
 if(state==='auxiliary')appendAuxiliaryUsageRecord(f.ledger,{id:'prediction-reservation',usageScope:'provider_request',requestPurpose:'input_prediction'});
 const r=native(f);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.value.lifetimeUsage.runtimeTurnCount,1);assert.equal(existsSync(f.intent),false);assert.deepEqual(nodePeer(f),r);next(f);
});
for(const mode of ['interrupt','crash'])for(const phase of ['after_intent','after_index','after_append','after_cleanup'])check(`native ${mode} ${phase} -> actual Node recovery and next turn`,()=>{
 const f=fixture(`${mode}-${phase}`),r=native(f,{PEER_NATIVE_USAGE_FAULT:`${mode}:${phase}`});
 if(mode==='interrupt')assert.deepEqual(r,{ok:false,code:'USAGE_LEDGER_COMMIT_UNCERTAIN'});
 else{
  assert.deepEqual(r,{status:77});assert.deepEqual(native(f),{ok:false,code:'STORE_LOCK_BUSY'});
  // The child has exited, all data and locks belong exclusively to this fixture.
  // Preserve diagnostics, then remove only the three proven, empty orphan dirs.
  const backup=path.join(f.root,'offline-maintenance-diagnostic');mkdirSync(backup);
  for(const file of [path.join(f.storeDir,'index.jsonl.lock'),f.intent+'.lock',f.ledger+'.lock']){cpSync(file,path.join(backup,path.basename(file)),{recursive:true});rmdirSync(file);}
  for(const file of [path.join(f.storeDir,'index.jsonl'),f.intent,f.ledger])if(existsSync(file))cpSync(file,path.join(backup,path.basename(file)));
 }
 const recovered=nodePeer(f);assert.equal(recovered.ok,true,JSON.stringify(recovered));assert.equal(recovered.value.lifetimeUsage.inputTokens,100);assert.equal(recovered.value.lifetimeUsage.runtimeTurnCount,1);
 assert.deepEqual(native(f),recovered);next(f,nodePeer);
});
check('native raw row order survives partial continuation by Node',()=>{
 const f=fixture('native-partial');assert.equal(native(f,{PEER_NATIVE_USAGE_FAULT:'interrupt:after_index'}).ok,false);
 const intent=JSON.parse(readFileSync(f.intent,'utf8'));writeFileSync(f.ledger,Buffer.from(intent.ledgerLine).subarray(0,171));
 const r=nodePeer(f);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.value.lifetimeUsage.runtimeTurnCount,1);next(f);
});
for(const kind of ['tail','prefix','counter','version','destination','line'])check(`native preserves and rejects unknown ${kind}`,()=>{
 const f=fixture(`conflict-${kind}`),intent=pending(f);
 if(kind==='tail')writeFileSync(f.ledger,'unrecognized partial row');
 if(kind==='prefix'){intent.prefixBytes=1;intent.prefixSha256='0'.repeat(64);writeFileSync(f.intent,JSON.stringify(intent));}
 if(kind==='counter'){const file=path.join(f.storeDir,'index.jsonl'),rows=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);rows[0].runtimeTurnCount=99;writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');}
 if(kind==='version'){intent.schemaVersion=999;writeFileSync(f.intent,JSON.stringify(intent));}
 if(kind==='destination'){intent.ledgerRelative='../some-other-ledger';writeFileSync(f.intent,JSON.stringify(intent));}
 if(kind==='line'){intent.ledgerLine='{}\n';writeFileSync(f.intent,JSON.stringify(intent));}
 const files=[path.join(f.storeDir,'index.jsonl'),f.ledger,f.intent],before=files.map(file=>readFileSync(file));
 assert.equal(native(f).ok,false);for(let i=0;i<files.length;i++)assert.deepEqual(readFileSync(files[i]),before[i]);
});
check('unknown metadata and per-model fields survive both writer implementations',()=>{
 const f=fixture('unknowns'),file=path.join(f.storeDir,'index.jsonl'),rows=readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 rows[0].futureMetadata={keep:['原始',1]};rows[0].lifetimeUsage={inputTokens:9,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,futureUsage:17,byModel:{[base.attribution.modelProviderId]:{inputTokens:9,futureModel:'keep',estimatedCostUsd:0.02}}};
 writeFileSync(file,rows.map(JSON.stringify).join('\n')+'\n');assert.equal(native(f).ok,true);next(f,nodePeer);
 const meta=f.store.getConversation(f.id);assert.deepEqual(meta.futureMetadata,{keep:['原始',1]});assert.equal(meta.lifetimeUsage.futureUsage,17);assert.equal(meta.lifetimeUsage.byModel[base.attribution.modelProviderId].futureModel,'keep');
});
for(const [name,bytes,code] of [
 ['bad-utf8',Buffer.from([0xa0,10]),'USAGE_LEDGER_INVALID'],
 ['unexpected-bom',Buffer.from('\ufeff{"id":"other"}\n'),'USAGE_LEDGER_INVALID'],
 ['unpaired-surrogate',Buffer.from('{"id":"\\ud800"}\n'),'USAGE_LEDGER_INVALID'],
 ['deep-row',Buffer.from('{"x":'.repeat(200)+'0'+'}'.repeat(200)+'\n'),'USAGE_LEDGER_LIMIT'],
 ['large-row',Buffer.from('x'.repeat(262145)),'USAGE_LEDGER_LIMIT'],
])check(`shared strict ${name} denial preserves the source`,()=>{
 const f=fixture(name);writeFileSync(f.ledger,bytes);const index=readFileSync(path.join(f.storeDir,'index.jsonl'));
 assert.deepEqual(native(f),{ok:false,code});assert.deepEqual(nodePeer(f),{ok:false,code});
 assert.deepEqual(readFileSync(f.ledger),bytes);assert.deepEqual(readFileSync(path.join(f.storeDir,'index.jsonl')),index);assert.equal(existsSync(f.intent),false);
});
function asyncWriter(command,args,f){return new Promise((resolve,reject)=>{const child=spawn(command,args,{stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));child.stdin.end(JSON.stringify({root:f.root,id:f.id,input:f.input}));});}
{
 const f=fixture('race');const [a,b]=await Promise.all([asyncWriter(binary,[],f),asyncWriter(process.execPath,['scripts/native-cli/usage-ledger-peer.mjs'],f)]);
 assert.equal(a.ok || a.code==='STORE_LOCK_BUSY',true,JSON.stringify(a));assert.equal(b.ok,true,JSON.stringify(b));
 assert.equal(native(f).ok,true);assert.equal(f.store.getConversation(f.id).runtimeTurnCount,1);next(f);cases++;console.log('ok real native/Node concurrent same-id writers (bounded contention may retry the billing identity)');
}
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const receipt={cases,root,binarySha256:digest(binary),contractSha256:digest('packages/protocol/contracts/native-cli/usage-ledger-v1.json'),scope:'Actual TS/Rust/Node Store processes; owned synthetic roots; no personal state; exact original partial line bytes; controlled offline orphan-lock maintenance after observed child exit'};
writeFileSync(path.join(root,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
