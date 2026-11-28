// Isolated storage promotion only. No task executor, grant, model or stop proof.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createWorkCoordinationStore } from '../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { protectCoordinationWriter } from '../../packages/runtime-node/src/project-agent/coordination-writer-fence.mjs';
import { createHostLease } from '../../packages/runtime-node/src/project-agent/host-lease.mjs';

const root=mkdtempSync(join(tmpdir(),'peer-native-fence-'));
writeFileSync(join(root,'.native-cli-fixture'),'synthetic');
const binary=resolve(process.argv[2]);let passed=0;
const steps=['prepared','baseline-copied','legacy-archived','writer-fenced','head-published','published'];
async function fixture(name:string,empty=false){
  const data=join(root,name);mkdirSync(data);writeFileSync(join(data,'.native-cli-fixture'),'synthetic');
  let now=1000;
  const lease=createHostLease({rootDir:join(data,'project-runtime'),hostId:'ts-fence',surface:'desktop',pid:process.pid,appVersion:'fixture',now:()=>now,schedule:()=>({unref(){}}),cancel(){}});
  assert.equal(lease.acquire('w').acquired,true);
  const options={rootDir:join(data,'project-runtime'),workspaceId:'w',holdsLease:()=>lease.holds('w'),leaseEpoch:()=>{
    const current=lease.diagnosticSnapshot('w');
    return current?`${current.hostId}:${current.acquiredAt}`:null;
  }};
  if(!empty){const old=createWorkCoordinationStore(options);old.saveWork({workId:'done',state:'delivered',future:{keep:'opaque'}});old.close();}
  const v2=createWorkCoordinationStore({...options,formatVersion:2});await v2.prepare();v2.close();
  const directory=join(data,'project-runtime/w');
  const original=empty?Buffer.alloc(0):readFileSync(join(directory,'coordination.jsonl'));
  return {data,directory,original,lease,options,setNow:(at:number)=>{now=at;},close:()=>lease.close()};
}
function native(data:string,stop_after:string|null=null){
  const result=spawnSync(binary,[],{env:{PATH:'/nonexistent',PEER_NATIVE_CONFORMANCE_ROOT:data},input:JSON.stringify({workspace:'w',now:1_000_000,stop_after}),encoding:'utf8',timeout:15000,maxBuffer:16384});
  assert.equal(result.error,undefined);assert.equal(result.status,stop_after?77:0,result.stderr);
  return JSON.parse(result.stdout);
}
async function verify(f:any){
  assert.ok(statSync(join(f.directory,'coordination.jsonl')).isDirectory());
  assert.throws(()=>appendFileSync(join(f.directory,'coordination.jsonl'),'old writer\n'),/EISDIR|EPERM|EACCES/);
  assert.deepEqual(readFileSync(join(f.directory,'coordination-v2/baseline.jsonl')),f.original);
  f.setNow(2_000_000);assert.equal(f.lease.acquire('w').acquired,true);
  const store=createWorkCoordinationStore({...f.options,formatVersion:2,fenceLegacyWrites:true});await store.prepare();
  if(f.original.length)assert.equal(store.readWork('done').state,'delivered');else assert.deepEqual(store.read().works,{});
  store.saveWork({workId:'later',state:'runnable'});assert.equal(store.readWork('later').state,'runnable');store.close();
}
for(const point of steps){
  const f=await fixture(`ts-to-native-${point}`);
  try{
    await assert.rejects(protectCoordinationWriter({directory:f.directory,assertOwner(){assert.equal(f.lease.holds('w'),true);},onStep(step){if(step===point)throw Error('fixture interruption');}}),/fixture interruption/);
    f.lease.release('w');assert.equal(native(f.data).ok,true);await verify(f);passed++;
  }finally{f.close();}
}
for(const point of steps){
  const f=await fixture(`native-to-ts-${point}`);
  try{
    f.lease.release('w');assert.equal(native(f.data,point).stoppedAfter,point);
    // The crashed native fixture leaves its real lease. Takeover is explicit;
    // this proves storage recovery only, never that an execution stopped.
    f.setNow(2_000_000);assert.equal(f.lease.acquire('w').acquired,true);
    await protectCoordinationWriter({directory:f.directory,assertOwner(){assert.equal(f.lease.holds('w'),true);}});
    await verify(f);passed++;
  }finally{f.close();}
}
for(const empty of [false,true]){
  const f=await fixture(empty?'empty':'healthy',empty);
  try{f.lease.release('w');assert.equal(native(f.data).ok,true);assert.equal(native(f.data).outcome,'AlreadyProtected');await verify(f);passed++;}finally{f.close();}
}
process.stdout.write(`${JSON.stringify({passed,fixtureRoot:root,coverage:'Real TS/native v2 writer promotion, six interruption points in each direction, retained terminal work and later v2 writes; no native executor or stop proof.'})}\n`);
