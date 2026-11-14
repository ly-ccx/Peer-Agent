// Actual TS backend and Rust Store/Runtime cross their canonical disk seam.
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';import { join,resolve } from 'node:path';import { spawnSync } from 'node:child_process';
import { createCoordinationStorageV2 } from '../../packages/runtime-node/src/project-agent/coordination-storage-v2.mjs';
import { recoveryHash } from '../../packages/runtime-node/src/project-agent/history-resumption.mjs';
const root=mkdtempSync(join(tmpdir(),'peer-native-kernel-store-'));const binary=resolve(process.argv[2]);
const fixture=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/coordination-kernels.json',import.meta.url),'utf8'));let cases=0;
for(const c of fixture.cases.filter(c=>!c.error)){
 const data=join(root,String(cases));mkdirSync(data);writeFileSync(join(data,'.native-cli-fixture'),'synthetic');
 const native=(extra:object)=>{const p=spawnSync(binary,[],{input:JSON.stringify(extra),env:{PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:data},encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024});assert.equal(p.status,0,p.stderr);const result=JSON.parse(p.stdout);assert.equal(result.ok,true,`${c.name}: ${JSON.stringify(result)}`);return result;};
 let current=native({initialize:true});
 if(c.entry.kind!=='history_reconciled'){
  const state={...c.previous,revision:0};const recovery={...(state.lastRecovery||{}),sourceFingerprint:state.lastRecovery?.sourceFingerprint||'a'.repeat(64),executionBlocked:true};
  current=native({event:{kind:'history_reconciled',state,stateHash:recoveryHash(state),recovery}});
 }
 const event=structuredClone(c.entry);for(const key of ['schemaVersion','storageVersion','revision','epoch','at','previousHash','hash'])delete event[key];
 if(event.kind.startsWith('history_')&&event.kind!=='history_reconciled')event.expectedRevision=current.state.revision;
 const written=native({event});
 const directory=join(data,'project-runtime/w');const ts=createCoordinationStorageV2({directory,legacyFile:join(directory,'coordination.jsonl'),assertOwner(){}});
 try{
  await ts.prepare();assert.deepEqual(ts.read(),written.state,c.name);
  ts.commitEntry({kind:'work',work:{workId:'ts-after',state:'queued'},schemaVersion:1,epoch:'ts-after',at:'2026-11-14T04:00:00.000Z'},null,{returnState:false});
  assert.deepEqual(native({}).state,ts.read(),`${c.name}: TS later write`);
 }finally{ts.close();}
 cases++;
}
console.log(JSON.stringify({ok:true,cases,fixture:root}));
