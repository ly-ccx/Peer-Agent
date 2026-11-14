import test from 'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import {installFr1Recorder}from'./fr1-recorder.mjs';import{createFr1Policy}from'./fr1-policy.mjs';import{createFr1Journal,replayFr1Journal}from'./fr1-journal.mjs';import{createFr1Profiler,fr1ProfileClock}from'./fr1-profiler.mjs';
function fixture(options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr1-unit-'));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}');
 let reads=0,fail=false;const error=Error('original'),index=[{}],value=[{id:'one'}],store={getStoreDir:()=>dir,getPlan:()=>({}),listEvidenceIndex:()=>{options.onIndex?.();return index;}},
 supervisor={list(){reads++;if(fail)throw error;for(let i=0;i<12;i++){store.getPlan();store.listEvidenceIndex();}return value;}};
 const application={list(){return supervisor.list({workspaceId:'scope'});},async nested(){await Promise.resolve();return application.list();},fail(){throw error;}};
 const original={list:supervisor.list,index:store.listEvidenceIndex,plan:store.getPlan};
 const recorder=installFr1Recorder({store,roots:[{object:supervisor,key:'list',kind:'list'}],entries:[{object:application,key:'list',kind:'ipc-list'},{object:application,key:'nested',kind:'ipc-nested'},{object:application,key:'fail',kind:'ipc-fail'}],epoch:'one',identityComplete:true,
  bounds:{rootSelfMs:1000,selfMs:10000},...options});
 return{dir,application,supervisor,store,original,recorder,error,value,index,get reads(){return reads;},set fail(v){fail=v;},close(){recorder.stop();fs.rmSync(dir,{recursive:true,force:true});}};
}
test('passive recorder retains every first natural root and current per-span stack with additive CPU',async()=>{
 const f=fixture();try{assert.equal(f.application.list(),f.value);assert.equal(f.reads,1);const b=await f.recorder.take(),r=b.records.find(r=>r.kind==='root').value;
 assert.equal(r.evidence.length,12);assert.equal(r.planCalls,12);assert.ok(r.evidence.every(x=>x.entryStack.id));assert.ok(r.entryId);
 assert.ok(Math.abs(r.userMs-r.evidenceUserMs-r.remainderUserMs)<1e-9);assert.equal(b.records[0].seq,1);
 assert.equal(f.recorder.request,undefined);assert.equal(f.recorder.native,undefined);assert.equal(f.recorder.read,undefined);
 assert.equal(f.recorder.state().controlledRequests,0);assert.equal(f.recorder.state().heapGetters,0);f.recorder.ack({throughSeq:b.throughSeq});assert.equal(f.recorder.state().retainedBytes,0);
 }finally{f.close();}
});
test('Promise/value/receiver and original exception survive; asynchronous parents are actual entries',async()=>{
 const f=fixture();try{const p=f.application.nested();assert.ok(p instanceof Promise);assert.equal(await p,f.value);
 assert.throws(()=>f.application.fail(),e=>e===f.error);f.fail=true;assert.throws(()=>f.application.list(),e=>e===f.error);
 const b=await f.recorder.take(),starts=b.records.filter(r=>r.kind==='entry-start');assert.ok(starts.find(r=>r.value.kind==='ipc-list'&&r.value.parentId===starts[0].value.id));
 assert.ok(b.records.some(r=>r.kind==='root'&&r.value.readFailure));
 }finally{f.close();}
});
test('exact original immutable batch, invalid ACK and idempotent completed ACK',async()=>{const f=fixture();try{f.application.list();const b=await f.recorder.take();assert.equal(await f.recorder.take(),b);
 assert.throws(()=>f.recorder.ack({throughSeq:b.throughSeq+1}),/ack_identity/);f.recorder.ack({throughSeq:b.throughSeq});assert.equal(f.recorder.ack({throughSeq:b.throughSeq}),true);
 }finally{f.close();}});
test('stop never overwrites a later owner, and CPU cap fails open to original product',()=>{const f=fixture();const newer=()=>['new'];f.supervisor.list=newer;assert.equal(f.recorder.stop('owner').restored,false);assert.equal(f.supervisor.list,newer);f.close();
 const g=fixture({bounds:{rootSelfMs:0,selfMs:10000}});try{assert.equal(g.application.list(),g.value);assert.equal(g.recorder.state().stopped,true);assert.equal(g.supervisor.list,g.original.list);assert.equal(g.application.list(),g.value);}finally{g.close();}});
test('lease restoration occurs without a controller and preserves unACKed original records',async()=>{const f=fixture({leaseMs:100});try{f.application.list();await new Promise(r=>setTimeout(r,130));assert.equal(f.recorder.state().stopReason,'controller-lease');assert.equal(f.supervisor.list,f.original.list);assert.ok((await f.recorder.take()).records.some(r=>r.kind==='root'));}finally{f.close();}});
const root=(id,user=400,evidence=280)=>({seq:id,kind:'root',value:{id,rootMethod:'list',scope:'x',epoch:'one',sourceBefore:'same',sourceAfter:'same',outputSha256:'output',planCalls:3859,portSequence:[{kind:'index',count:12}],identityComplete:true,phase:'unused',start:id*500,end:id*500+430,userMs:user,evidenceUserMs:evidence,evidence:Array.from({length:12},()=>({rows:69266}))}});
function learned(){const p=createFr1Policy({startedMs:0});p.observe(Array.from({length:9},(_,i)=>root(i+1)),5000);return p;}
test('first nine chronological roots freeze baseline without GC filtering; first witness precedes optional profile',()=>{
 const p=learned();assert.equal(p.state().cohorts[0].baseline.root,400);p.observe([root(10,440,315)],6000);assert.equal(p.state().event.rootId,10);assert.equal(p.profileClaim(),false);
 p.observe([root(11,440,315),root(12,440,315),root(13,440,315)],9000);assert.equal(p.state().event.outcome,'whole-query-change-candidate');assert.equal(p.profileClaim(),true);assert.equal(p.profileClaim(),false);
 assert.deepEqual(p.state().cohorts[0].baseline.rootIds,[1,2,3,4,5,6,7,8,9]);assert.equal(p.state().performanceQualified,false);
});
test('Evidence redistribution is not whole-query slowdown, natural followups never replaced',()=>{const p=learned();p.observe([root(10,400,315)],6000);p.observe([root(11,400,315),root(12,400,315),root(13,400,315)],9000);assert.equal(p.state().event.outcome,'redistribution-candidate');assert.equal(p.state().wholeQueryChangeCandidate,false);});
test('no baseline still triggers wall but cannot invent a fast history or a profile',()=>{const p=createFr1Policy({startedMs:0});const r=root(1);r.value.end=r.value.start+2000;p.observe([r],3000);assert.equal(p.state().event.type,'wall');p.observe([root(2),root(3),root(4)],4000);assert.equal(p.state().event.wholeQueryChangeCandidate,false);assert.equal(p.profileClaim(),false);});
test('coverage, full reservation and original field deadline are separate stop conditions',()=>{assert.equal(learned().tick(600000).reason,'coverage-insufficient');const p=learned();p.observe([{kind:'entry-start',value:{kind:'ipc-list',foregroundDelivery:true}},{kind:'entry-start',value:{kind:'ipc-get',foregroundDelivery:true}}],5001);p.observe([root(10,440,315)],1540001);assert.equal(p.state().event,null);assert.equal(p.tick(1710000).reason,'field-deadline-cleanup');});
test('hash-linked journal preserves fsync failure bytes and recovers the same original batch once',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr1-journal-'));let fail=true;const file=path.join(dir,'facts'),j=createFr1Journal(file,{sync:fd=>{if(fail){fail=false;throw Error('fsync');}fs.fdatasyncSync(fd);}}),b={records:[{seq:1,kind:'original',value:{}}],throughSeq:1};
 try{assert.throws(()=>j.commit(b),/fsync/);const n=fs.statSync(file).size;assert.equal(j.pending,b);assert.throws(()=>j.commit({...b}),/original_pending/);j.commit(b);assert.equal(fs.statSync(file).size,n);assert.equal(replayFr1Journal(fs.readFileSync(file,'utf8')).records.length,1);
 }finally{j.close();fs.rmSync(dir,{recursive:true,force:true});}});
test('missing/corrupt archive history cannot become complete',()=>{assert.throws(()=>replayFr1Journal(JSON.stringify({chunk:1,previous:'x',sha256:'y',batch:{records:[],throughSeq:0}})),/chain_invalid/);});
function inspectorMock(fault){return{Session:class{connect(){}disconnect(){}post(method,params,cb){if(method===fault)return cb(Error('injected-'+method));cb(null,method==='Profiler.stop'?{profile:{startTime:1000,endTime:2000,nodes:[],samples:[],timeDeltas:[]}}:{});}}};}
test('one start only; unknown start reconciles stop/disable without another start',()=>{const events=[],p=createFr1Profiler({emit:(k,v)=>events.push(k),module:inspectorMock('Profiler.start')});p.arm();p.onNaturalEntry();assert.equal(p.state().startAttempts,1);assert.equal(p.state().disabled,true);assert.equal(p.state().phase,'done');assert.throws(()=>p.arm(),/one_attempt/);assert.ok(events.includes('profile-error'));});
test('clock mapping uses bounded command endpoints and rejects unexplained origins',()=>{assert.equal(fr1ProfileClock(null,{}).valid,false);assert.equal(fr1ProfileClock({startTime:1000,endTime:2000},{startBefore:{performanceMs:10},startAfter:{performanceMs:11},stopBefore:{performanceMs:11},stopAfter:{performanceMs:12}}).valid,true);});

import {runFr1Controller}from'./fr1-controller.mjs';
test('shared controller seals durable first witness before profile and never obtains a business-read capability',async()=>{
 let clock=10000,stopped=false,armed=0;const trace=[],batches=[Array.from({length:10},(_,i)=>root(i+1,i===9?440:400,i===9?315:280)),[root(11,440,315),root(12,440,315),root(13,440,315)]];
 const r=await runFr1Controller({startedMs:10000,report:{failures:[]},io:{now:()=>clock,cancelled:()=>false,budget:()=>true,terminal:()=>null,heartbeatAge:()=>0,
  dataReady:()=>Boolean(batches.length),drain:async()=>{trace.push('durable');return{records:batches.shift()};},forPolicy:x=>x,control:async k=>trace.push(k),renew:async()=>{},
  armProfile:async()=>{armed++;trace.push('profile');},profileState:async()=>({phase:'done'}),saveProfile:async()=>({scope:'mock-only'}),progress:async()=>{},wait:async()=>{clock+=100;},
  nativeSample:async()=>{throw Error('unexpected-native');},stop:async()=>{stopped=true;return{restored:true};}}});
 assert.equal(armed,1);assert.equal(stopped,true);assert.ok(trace.indexOf('first-witness-durable-before-profile')<trace.indexOf('profile'));assert.equal(r.observation.wholeQueryChangeCandidate,true);assert.equal(r.fieldCauseEstablished,false);
});
test('external stall path runs while metadata is unavailable and cancellation still restores',async()=>{
 let clock=0,step=0,native=0,stop=0;const r=await runFr1Controller({startedMs:0,report:{failures:[]},io:{now:()=>clock,cancelled:()=>step>1,budget:()=>true,terminal:()=>null,heartbeatAge:()=>1500,
  control:async()=>{},nativeSample:async()=>{native++;return{complete:true};},progress:async()=>{},wait:async()=>{step++;clock+=100;},stop:async()=>{stop++;return{restored:true};}}});
 assert.equal(native,1);assert.equal(stop,1);assert.equal(r.reason,'fr1_cancelled');assert.equal(r.refactorStarted,false);
});
test('archive failure aborts admission and invokes restoration without another read',async()=>{
 let calls=0,stops=0;const r=await runFr1Controller({startedMs:0,report:{failures:[]},io:{now:()=>0,cancelled:()=>false,budget:()=>true,terminal:()=>null,heartbeatAge:()=>0,dataReady:()=>true,
  drain:async()=>{calls++;throw Error('fsync-original-retained');},stop:async()=>{stops++;return{restored:true};}}});assert.equal(calls,1);assert.equal(stops,1);assert.equal(r.reason,'fsync-original-retained');
});
test('durable duplicate batch following unknown ACK is recognized, not appended as new history',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr1-duplicate-')),file=path.join(dir,'facts'),j=createFr1Journal(file),b={records:[{seq:1,kind:'fact',value:{}}],throughSeq:1};
 try{const r=j.commit(b),n=j.bytes;assert.deepEqual(j.commit(JSON.parse(JSON.stringify(b))),r);assert.equal(j.bytes,n);assert.equal(replayFr1Journal(fs.readFileSync(file,'utf8')).seq,1);}finally{j.close();fs.rmSync(dir,{recursive:true,force:true});}});
test('native-overlap baseline keeps the original nine roots but cannot qualify a natural transition',()=>{const p=createFr1Policy({startedMs:0}),initial=Array.from({length:9},(_,i)=>root(i+1));initial[0].value.samplerOverlap=true;p.observe(initial,5000);p.observe([root(10,440,315),root(11,440,315),root(12,440,315),root(13,440,315)],9000);assert.equal(p.state().cohorts[0].baseline.diagnosticOverlap,true);assert.equal(p.state().event.wholeQueryChangeCandidate,false);assert.deepEqual(p.state().cohorts[0].baseline.rootIds,[1,2,3,4,5,6,7,8,9]);});
test('profiler stop failure still disables, and disable failure cannot claim known disabled',()=>{for(const fault of ['Profiler.stop','Profiler.disable']){const p=createFr1Profiler({emit:()=>{},module:inspectorMock(fault)});p.arm();p.onNaturalEntry();p.stop();assert.equal(p.state().startAttempts,1);assert.equal(p.state().disabled,fault!=='Profiler.disable');assert.ok(p.state().errors.some(e=>e.message.includes(fault)));}});
test('failed span never becomes a comparable complete query',()=>{const p=createFr1Policy({startedMs:0}),bad=root(1);bad.value.evidence[0].readFailure=true;p.observe([bad,...Array.from({length:8},(_,i)=>root(i+2))],5000);assert.equal(p.state().cohorts[0]?.baseline??null,null);});

test('every current stack is captured; only an identical full location vector reuses presentation',async()=>{
 const f=fixture();function fromFirstCaller(){return f.application.list();}function fromOtherCaller(){return f.application.list();}
 try{fromFirstCaller();fromOtherCaller();const b=await f.recorder.take(),stacks=new Map(b.records.filter(x=>x.kind==='stack').map(x=>[x.value.id,x.value])),roots=b.records.filter(x=>x.kind==='root');
  assert.equal(roots.length,2);assert.notEqual(roots[0].value.entryStack.id,roots[1].value.entryStack.id);
  const first=stacks.get(roots[0].value.evidence[0].entryStack.id),second=stacks.get(roots[1].value.evidence[0].entryStack.id);
  assert.ok(first.text.includes('fromFirstCaller'));assert.ok(second.text.includes('fromOtherCaller'));assert.ok(first.frames.length>3);assert.equal(first.encoding,'node-call-sites-v1');assert.ok(first.frames.every(x=>typeof x.scriptId==='string'&&Number.isInteger(x.lineNumber)));assert.equal(first.asyncParents,'mapped-ALS-only');
  const s=f.recorder.state();assert.ok(s.stackCaptures>=28);assert.ok(s.stackMaterializations<s.stackCaptures);assert.equal(f.reads,2);
 }finally{f.close();}
});
test('stack hooks and limit descriptors are restored before original code runs, including failure',()=>{
 const old=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace'),limit=Object.getOwnPropertyDescriptor(Error,'stackTraceLimit');let calls=0;const prepare=()=>{calls++;return 'external-formatter';};
 Object.defineProperty(Error,'prepareStackTrace',{configurable:true,writable:false,value:prepare});const expected=Object.getOwnPropertyDescriptor(Error,'prepareStackTrace'),f=fixture();
 try{f.application.list();assert.deepEqual(Object.getOwnPropertyDescriptor(Error,'prepareStackTrace'),expected);assert.deepEqual(Object.getOwnPropertyDescriptor(Error,'stackTraceLimit'),limit);
  assert.equal(new Error('outside').stack,'external-formatter');assert.equal(calls,1);f.fail=true;assert.throws(()=>f.application.list(),e=>e===f.error);assert.deepEqual(Object.getOwnPropertyDescriptor(Error,'prepareStackTrace'),expected);
 }finally{f.close();if(old)Object.defineProperty(Error,'prepareStackTrace',old);else delete Error.prepareStackTrace;}
});

import {snapshotFr1TargetFiles,assertFr1Target} from './fr1-target.mjs';
test('target source epoch includes content and refuses later source mutation',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr1-target-'));fs.mkdirSync(path.join(dir,'main'));fs.writeFileSync(path.join(dir,'main','entry.mjs'),'original');
 try{const files=snapshotFr1TargetFiles(dir,['main']);assert.equal(files.length,1);assert.equal(files[0].sha256.length,64);
  const executable=process.getBuiltinModule('child_process').execFileSync('ps',['-p',String(process.pid),'-o','comm='],{encoding:'utf8'}).trim(),config={pid:process.pid},target={root:dir,executable,files};
  assert.equal(assertFr1Target(config,target),true);fs.writeFileSync(path.join(dir,'main','entry.mjs'),'changed');assert.throws(()=>assertFr1Target(config,target),/source_epoch_changed/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('shared span boundaries use exactly four CPU snapshots without dropping per-pass CPU',async()=>{
 const original=process.threadCpuUsage,points=[];let count=0;process.threadCpuUsage=function(...args){count++;return Reflect.apply(original,process,args);};
 const f=fixture({onIndex:()=>points.push(count)});
 try{f.application.list();assert.equal(points.length,12);assert.ok(points.slice(1).every((x,i)=>x-points[i]===4));
  const b=await f.recorder.take(),r=b.records.find(x=>x.kind==='root').value;assert.ok(r.evidence.every(e=>e.userMs>=0&&e.systemMs>=0&&e.selfMs>=0));assert.ok(Math.abs(r.userMs-r.evidenceUserMs-r.remainderUserMs)<1e-8);
 }finally{f.close();process.threadCpuUsage=original;}
});
