import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkCoordinationStore } from '../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { createHostLease } from '../../packages/runtime-node/src/project-agent/host-lease.mjs';
const root=mkdtempSync(join(tmpdir(),'peer-native-canonical-'));const binary=resolve(process.argv[2]);let cases=0;
async function fixture(name:string,control=false,payload=false,fenced=false){
 const data=join(root,name);mkdirSync(data);writeFileSync(join(data,'.native-cli-fixture'),'synthetic');let now=1000;
 const lease=createHostLease({rootDir:join(data,'project-runtime'),hostId:'ts-canonical',surface:'desktop',pid:process.pid,appVersion:'fixture',now:()=>now,schedule:()=>({unref(){}}),cancel(){}});
 assert.equal(lease.acquire('w').acquired,true);
 const options={rootDir:join(data,'project-runtime'),workspaceId:'w',holdsLease:()=>lease.holds('w'),leaseEpoch:()=>{const r=lease.diagnosticSnapshot('w');return r?`${r.hostId}:${r.acquiredAt}`:null;}};
 const legacy=createWorkCoordinationStore(options);legacy.saveWork({workId:'legacy',state:'delivered',future:{keep:true}});legacy.close();
 const s=createWorkCoordinationStore({...options,formatVersion:2,fenceLegacyWrites:fenced});await s.prepare();
 s.saveWork({workId:'current',state:'running',budget:{tokens:0,observations:{}},opaque:payload?'x'.repeat(70000):'preserved'});
 s.saveWork({workId:'current',state:'delivered',budget:{tokens:1,observations:{one:true}},opaque:payload?'x'.repeat(70000):'preserved'});
 if(control){const f=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/control-v1.json',import.meta.url),'utf8'));const entry=f.cases[0].entry;s.writeSessionControl(entry.operation,entry.expectedRevision,entry.expectedCurrentOperationId);}
 const state=s.read();s.close();lease.release('w');
 const directory=join(data,'project-runtime/w');
 return{data,directory,state,lease,options,setNow:(n:number)=>now=n};
}
function native(f:any,protect=false,extra:object={},status=0){const p=spawnSync(binary,[],{env:{PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:f.data},input:JSON.stringify({protect,...extra}),encoding:'utf8',timeout:10000});assert.equal(p.status,status,p.stderr);return status===0?JSON.parse(p.stdout):null;}
for(const [name,control,payload,fenced]of [['plain',false,false,false],['payload',false,true,false],['control',true,false,true],['protected',false,false,true]]as const){
 const f=await fixture(name,control,payload,fenced);try{const result=native(f);assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(result.state,f.state);cases++;if(!fenced){const promoted=native(f,true);assert.equal(promoted.ok,true,JSON.stringify(promoted));assert.equal(promoted.fenced,true);assert.deepEqual(promoted.state,f.state);cases++;}
 const written=native(f,false,{event:{kind:'work_updated',workId:'native',work:{workId:'native',state:'queued',opaque:payload?'b'.repeat(70000):'native'},removed:[]}});assert.equal(written.ok,true,JSON.stringify(written));assert.equal(written.state.works.native.state,'queued');cases++;
 const interrupted=native(f,false,{interrupt:true,event:{kind:'work_updated',workId:'pending',work:{workId:'pending',state:'queued'},removed:[]}});assert.equal(interrupted.code,'coordination_durable_pending_projection');cases++;
 const pending=native(f);assert.equal(pending.ok,true,JSON.stringify(pending));assert.equal(pending.state.works.pending.state,'queued');assert.equal(pending.state.revision,pending.headRevision+1);cases++;
 const blocked=native(f,false,{event:{kind:'work_updated',workId:'blocked',work:{state:'queued'},removed:[]}});assert.equal(blocked.code,'coordination_durable_pending_projection');cases++;
 const recovered=native(f,false,{checkpoint:true,event:{kind:'work_updated',workId:'after-head',work:{state:'queued'},removed:[]}});assert.equal(recovered.ok,true,JSON.stringify(recovered));cases++;
 f.setNow(2_000_000);assert.equal(f.lease.acquire('w').acquired,true);const later=createWorkCoordinationStore({...f.options,formatVersion:2,fenceLegacyWrites:true});await later.prepare();assert.deepEqual(later.read(),recovered.state);later.saveWork({workId:'later',state:'queued'});assert.equal(later.readWork('later').state,'queued');later.close();cases++;
 }finally{f.lease.close()}
}
for(const kind of ['hash','head','partial','baseline','schema','blob']as const){
 const f=await fixture(`bad-${kind}`,false,kind==='blob',true);try{
  const dir=join(f.directory,'coordination-v2');const segment=join(dir,'segments',readdirSync(join(dir,'segments')).filter(n=>n.endsWith('.jsonl')).sort().at(-1)!);
  let target=segment;
  if(kind==='hash'){const lines=readFileSync(segment,'utf8').trim().split('\n');let last=JSON.parse(lines.at(-1)!);last.hash='0'.repeat(64);lines[lines.length-1]=JSON.stringify(last);writeFileSync(segment,lines.join('\n')+'\n');}
  if(kind==='head'){target=join(dir,'head.json');const h=JSON.parse(readFileSync(target,'utf8'));h.hash='f'.repeat(64);writeFileSync(target,JSON.stringify(h));}
  if(kind==='partial')writeFileSync(segment,readFileSync(segment,'utf8')+'{partial');
  if(kind==='baseline'){target=join(dir,'baseline.jsonl');writeFileSync(target,readFileSync(target,'utf8')+' ');}
  if(kind==='schema'){target=join(dir,'manifest.json');const m=JSON.parse(readFileSync(target,'utf8'));m.minimumReaderVersion=m.minimumWriterVersion=99;writeFileSync(target,JSON.stringify(m));}
  if(kind==='blob'){target=join(dir,'blobs',readdirSync(join(dir,'blobs'))[0]);writeFileSync(target,'{}');}
  const before=readFileSync(target);const result=native(f);assert.equal(result.ok,false,kind);assert.deepEqual(readFileSync(target),before);cases++;
 }finally{f.lease.close()}
}
const crash=await fixture('crash',false,false,true);try{
 native(crash,false,{crash:true,event:{kind:'work_updated',workId:'crash-pending',work:{state:'queued'},removed:[]}},77);
 const held=native(crash);assert.equal(held.code,'fixture_lease_held');cases++;
 const pending=native(crash,false,{now:2_000_000});assert.equal(pending.ok,true,JSON.stringify(pending));assert.equal(pending.state.works['crash-pending'].state,'queued');cases++;
 const repaired=native(crash,false,{checkpoint:true,now:3_000_000,event:{kind:'work_updated',workId:'next',work:{state:'queued'},removed:[]}});assert.equal(repaired.ok,true,JSON.stringify(repaired));cases++;
}finally{crash.lease.close()}
const floorFixture=await fixture('floor-upgrade',false,false,true);try{
 const e=JSON.parse(readFileSync(new URL('../../packages/protocol/contracts/native-cli/control-v1.json',import.meta.url),'utf8')).cases[0].entry;
 const result=native(floorFixture,false,{event:{kind:'session_control',...e}});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.state.sessionControlHeads.s.operationId,'a');cases++;
 const manifest=JSON.parse(readFileSync(join(floorFixture.directory,'coordination-v2/manifest.json'),'utf8'));assert.equal(manifest.minimumWriterVersion,9);cases++;
}finally{floorFixture.lease.close()}
const interruptedFloor=await fixture('floor-pending',false,false,true);try{
 const path=join(interruptedFloor.directory,'coordination-v2/head.json');const h=JSON.parse(readFileSync(path,'utf8'));h.minimumWriterVersion=9;writeFileSync(path,JSON.stringify(h));
 assert.equal(native(interruptedFloor).code,'coordination_schema_unsupported');cases++;
 const recovered=native(interruptedFloor,false,{recover:true});assert.equal(recovered.ok,true,JSON.stringify(recovered));assert.deepEqual(recovered.state,interruptedFloor.state);cases++;
}finally{interruptedFloor.lease.close()}
for(const legacy of [false,true]){
 const data=join(root,legacy?'native-legacy-init':'native-empty-init');mkdirSync(data);writeFileSync(join(data,'.native-cli-fixture'),'synthetic');
 const directory=join(data,'project-runtime/w');mkdirSync(directory,{recursive:true});
 if(legacy){const s=createWorkCoordinationStore({rootDir:join(data,'project-runtime'),workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'fixture'});s.saveWork({workId:'original',state:'delivered'});s.close();}
 const initialized=native({data},false,{initialize:true});assert.equal(initialized.ok,true,JSON.stringify(initialized));assert.equal(initialized.fenced,true);assert.equal(initialized.state.revision,legacy?1:0);cases++;
 const s=createWorkCoordinationStore({rootDir:join(data,'project-runtime'),workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'fixture-ts',formatVersion:2,fenceLegacyWrites:true});await s.prepare();assert.deepEqual(s.read(),initialized.state);s.saveWork({workId:'later',state:'queued'});const expected=s.read();s.close();assert.deepEqual(native({data}).state,expected);cases++;
}
for(const mode of ['cancel','head','lease','blob']as const){
 const f=await fixture(`during-${mode}`,false,mode==='blob',true);try{
  const result=native(f,false,{during:mode});assert.equal(result.ok,false,mode);assert.equal(result.code,{cancel:'CANCELLED',head:'coordination_read_changed',lease:'HOST_LEASE_LOST',blob:'coordination_read_changed'}[mode]);cases++;
 }finally{f.lease.close()}
}
const unsupported=await fixture('unsupported-canonical',false,false,true);try{
 unsupported.setNow(2_000_000);assert.equal(unsupported.lease.acquire('w').acquired,true);
 const s=createWorkCoordinationStore({...unsupported.options,formatVersion:2,fenceLegacyWrites:true});await s.prepare();
 const decision=s.decide({operationId:'operation',workId:'unported',expectedRevision:0,action:'parallel',sourceInputIds:['input'],sourceEventIds:[],reason:'synthetic'},{parentConversationId:'bot',currentInputIds:['input'],eventIds:[],policyRevision:'fixture'});assert.equal(decision.ok,true,JSON.stringify(decision));const expected=s.read();s.close();unsupported.lease.release('w');
 const result=native(unsupported,false,{event:{kind:'work_updated',workId:'must-not-appear',work:{state:'queued'},removed:[]}});assert.equal(result.code,'coordination_native_reducer_unsupported');cases++;
 unsupported.setNow(3_000_000);assert.equal(unsupported.lease.acquire('w').acquired,true);const compatible=createWorkCoordinationStore({...unsupported.options,formatVersion:2,fenceLegacyWrites:true});await compatible.prepare();assert.deepEqual(compatible.read(),expected);assert.equal(compatible.readWork('must-not-appear'),undefined);compatible.close();cases++;
}finally{unsupported.lease.close()}
for(const orphan of ['orphan.log','segments/orphan.jsonl.damaged']){
 const data=join(root,orphan==='orphan.log'?'unknown-root':'unknown-segment');mkdirSync(join(data,'project-runtime/w/coordination-v2/segments'),{recursive:true});writeFileSync(join(data,'.native-cli-fixture'),'synthetic');const path=join(data,'project-runtime/w/coordination-v2',orphan);writeFileSync(path,'unknown effects');const bytes=readFileSync(path);assert.equal(native({data},false,{initialize:true}).code,'coordination_recovery_pending');assert.deepEqual(readFileSync(path),bytes);cases++;
}
console.log(JSON.stringify({ok:true,cases,fixture:root}));
