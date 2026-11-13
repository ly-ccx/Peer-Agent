import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
import{startOwnedE3Host}from'./ri00/e3-owned-host.mjs';import{startE3Counter}from'./ri00/e3-counter-client.mjs';import{e3SourceIdentity}from'./ri00/e3-identity.mjs';
import{evaluateE3Checkpoint,qualifiedE3Fast,qualifiedE3FastPair,qualifiedE3Dense}from'./ri00/e3-checkpoint.mjs';import{browserMainCounterDelta}from'./ri00/thread-counter-delta.mjs';
import{productionIdentity,resolveDestination}from'./ri00/identity.mjs';import{sourceInventory}from'./ri00/source-archive.mjs';
const args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1];for(const k of['--config','--qualification','--baseline','--output'])if(!args.includes(k))throw Error('e3_order_explicit_arguments_required');
const hash=b=>createHash('sha256').update(b).digest('hex'),read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const base=read(option('--config')),qualificationBytes=fs.readFileSync(option('--qualification')),qualification=JSON.parse(qualificationBytes),baseline=read(option('--baseline'));
const source=e3SourceIdentity(),shared=['dense-residual-probe.mjs','read-ticket-queue.mjs','e3-install.mjs','read-host.mjs','readonly-coordination.mjs','coordination-snapshot.mjs','e3-counter-client.mjs'];
assert.equal(qualification.passed,true);assert.equal(qualification.originalBootstrapFailureRetained,true);assert.equal(qualification.totalE3OwnedQLaunchesIncludingTwoExploratory,5);assert.ok(Object.values(qualification.proofs).every(Boolean));
for(const name of shared)assert.equal(source.find(x=>x.relative===name).sha256,qualification.source.find(x=>x.relative===name).sha256);
const ownedAdapterDelta=source.filter(x=>qualification.source.find(y=>y.relative===x.relative)?.sha256!==x.sha256).map(x=>x.relative);
assert.ok(ownedAdapterDelta.every(x=>['e3-owned-main.cjs','e3-owned-host.mjs'].includes(x)));
const output=resolveDestination(option('--output')),coordinationDir=path.dirname(path.dirname(base.coordinationSnapshot));
if(fs.existsSync(output)||output.startsWith(fs.realpathSync(base.fixtureRoot)+path.sep)||output.startsWith(fs.realpathSync(base.moduleRoot)+path.sep))throw Error('e3_order_new_isolated_output_required');
fs.mkdirSync(output,{recursive:true,mode:0o700});
const expectedRow=baseline.epochs[0].mainA.points[0].row,expected={sessions:expectedRow.rows,evidenceRows:expectedRow.evidence[0].rows,planCalls:3859,outputSha256:expectedRow.outputSha256};
const driverFiles=[new URL(import.meta.url),new URL('./ri00/e3-checkpoint.mjs',import.meta.url)],driverIdentity=()=>driverFiles.map(u=>({relative:path.basename(u.pathname),sha256:hash(fs.readFileSync(u))}));
const report={kind:'E3-fixed-within-process-order-experiment-not-field-attribution',startedAt:new Date().toISOString(),source,driver:driverIdentity(),qualificationReceiptSha256:hash(qualificationBytes),
 candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:fileURLToPath(new URL('../../../',import.meta.url)),encoding:'utf8'}).trim(),production:productionIdentity(base.moduleRoot),expected,
 qualificationScope:{sharedSamplerUnchanged:true,originalBootstrapFailureRetained:true,ownedAdapterDelta,postShutdownSemanticAuditIsNewOwnedOnly:true},
 fixedOrder:[['C1','control'],['T1','treatment'],['T2','treatment'],['C2','control'],['C3','control'],['T3','treatment']],targets:[],ownedLaunches:0,readCpuMs:0,readCpuLimitMs:300000,failures:[],mechanicsOk:false,orderHypothesisSupported:false,fieldAttribution:false};
report.targets=report.fixedOrder.map(([label,arm])=>({label,arm,status:'not-started',checkpoints:[],tickets:[],readCpuMs:0}));
let reference,target,counter,interrupted=false;const began=Date.now(),maxWallMs=1500000,wait=ms=>new Promise(r=>setTimeout(r,ms));
const activeHosts=new Set();
process.on('SIGINT',()=>{interrupted=true;});process.on('SIGTERM',()=>{interrupted=true;});
const save=()=>{const temporary=path.join(output,'report.tmp'),fd=fs.openSync(temporary,'w',0o600);try{fs.writeSync(fd,JSON.stringify(report));fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,path.join(output,'report.private.json'));};
const currentSource=()=>sourceInventory(base.fixtureRoot,coordinationDir);
let expectedSource,indexSha,nativeSequence=0,journalBytes=0;const journalLimitBytes=33554432,hashBuffer=Buffer.allocUnsafe(1048576);
function appendJournal(name,line){
 const bytes=Buffer.byteLength(line);if(journalBytes+bytes>journalLimitBytes)throw Error('e3_order_journal_budget');
 const fd=fs.openSync(path.join(output,name),'a',0o600);try{fs.writeFileSync(fd,line);fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}journalBytes+=bytes;
}
function fileSha(file){const h=createHash('sha256'),fd=fs.openSync(file,'r');try{let n;while((n=fs.readSync(fd,hashBuffer,0,hashBuffer.length,null)))h.update(hashBuffer.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex');}
function budget(){if(interrupted)throw Error('e3_order_interrupted');if(Date.now()-began>maxWallMs)throw Error('e3_order_wall_budget');if(report.readCpuMs>=report.readCpuLimitMs)throw Error('e3_order_read_cpu_budget');}
async function take(host){
 const batch=await host.rpc('take'),line=JSON.stringify({host:host.label,at:new Date().toISOString(),batch})+'\n';
 appendJournal('batches.private.jsonl',line);await host.rpc('ackBatch');
 const delta=batch.state.controlledCpuMs-host.chargedCpu;assert.ok(delta>=-.001);host.chargedCpu=batch.state.controlledCpuMs;report.readCpuMs+=Math.max(0,delta);host.record.readCpuMs=host.chargedCpu;
 if(batch.state.metadataErrors||batch.state.dropped||batch.state.gcDropped||batch.state.ledgerOverflows)throw Error('e3_order_probe_record_failure');return batch;
}
async function readTicket(host,kind,label){
 budget();await host.rpc('renew');const id=++host.nextId,before=await counter.read(host.child.pid);assert.equal(String(before.values.ri_proc_start_abstime),host.birth);
 await host.rpc('request',{id,kind,label,sourceEpoch:expectedSource.sha256});const ticket=await host.rpc('wait',{id}),after=await counter.read(host.child.pid);assert.equal(String(after.values.ri_proc_start_abstime),host.birth);
 const nativeId=++nativeSequence,nativeLine=JSON.stringify({nativeId,host:host.label,id,before,after})+'\n';
 appendJournal('native-points.private.jsonl',nativeLine);
 const batch=await take(host);await host.rpc('ackTicket',{id});const rows=batch.rows.filter(r=>r.ticketId===id),summary={id,kind,label,ticket,rows,nativeId};host.record.tickets.push({id,kind,label,ticket,nativeId});
 if(ticket.state!=='completed'||ticket.stoppedDuringRun)throw Error('e3_order_ticket_incomplete:'+ticket.state);
 const count=kind.startsWith('order-')?9:1;assert.equal(rows.length,count);assert.ok(rows.every(r=>r.sourceBefore===r.sourceAfter&&!r.readFailure&&!r.metadataFailure));
 if(count===1)summary.pmc=browserMainCounterDelta(before,after,counter.ready.timebase,rows[0].userMs+rows[0].systemMs);
 budget();return summary;
}
async function block(host,label){
 const b={host:host.label,label,points:[],calibration:[],complete:false};
 for(let i=0;i<8;i++){const t=await readTicket(host,'dense',label+'-'+i);b.points.push({row:t.rows[0],pmc:t.pmc,nativeId:t.nativeId});await wait(150);}
 for(let i=0;i<3;i++){budget();b.calibration.push(await host.rpc('native'));}b.complete=true;return b;
}
async function checkpoint(record,state,label){
 budget();const before=currentSource(),mainA=await block(target,label+'-a'),ref=await block(reference,label+'-r'),mainB=await block(target,label+'-b'),after=currentSource();
 const sourceStable=before.sha256===expectedSource.sha256&&after.sha256===expectedSource.sha256;
 const identity=hash(JSON.stringify([target.child.pid,target.birth,reference.child.pid,reference.birth,expectedSource.sha256,indexSha,target.ready.runtime,reference.ready.runtime]));
 const evaluation=evaluateE3Checkpoint(state,{identity,mainA,reference:ref,mainB,sourceStable,expected}),result={label,relativeMs:Date.now()-began,mainA,reference:ref,mainB,...evaluation};record.checkpoints.push(result);save();
 console.log(JSON.stringify({target:record.label,checkpoint:label,status:result.gate.status,reason:result.gate.reason,deltas:result.gate.deltas,summaries:result.gate.summaries,calibrationStable:result.calibrationStable,validation:result.validation,readCpuMs:report.readCpuMs}));return result;
}
async function launch(label,record){
 budget();report.ownedLaunches++;save();const host=await startOwnedE3Host({...base,mode:'production',qualification:false,output:path.join(output,label),label,epoch:expectedSource.sha256,
  allowExposure:true,auditOnShutdown:true,hostDeadlineMs:label==='reference'?maxWallMs+30000:180000,leaseMs:90000,readCpuLimitMs:300000});
 activeHosts.add(host);
 host.label=label;host.record=record;host.nextId=0;host.chargedCpu=0;assert.equal(host.ready.pid,host.child.pid);const p=await counter.read(host.child.pid);host.birth=String(p.values.ri_proc_start_abstime);
 record.runtime=host.ready.runtime;record.birth=host.birth;record.pid=host.child.pid;record.indexFileSha256=hash(fs.readFileSync(host.ready.indexFile));assert.equal(record.indexFileSha256,indexSha);
 for(const key of['node','electron','v8','cachedDataVersionTag'])assert.equal(host.ready.runtime[key],baseline.mainRuntime[key]);return host;
}
async function close(host){
 let collectError;try{await take(host);}catch(error){collectError=error;}
 let end;try{end=await host.close({skipAudit:report.readCpuMs+1000>report.readCpuLimitMs});await host.closed;}finally{activeHosts.delete(host);}
 host.record.exit=end;
 if(end.postMeasurementAudit){report.readCpuMs+=end.postMeasurementAudit.cpuMs;host.record.postAuditCpuMs=end.postMeasurementAudit.cpuMs;assert.equal(end.postMeasurementAudit.failed,undefined);assert.equal(end.postMeasurementAudit.skipped,undefined);assert.equal(end.postMeasurementAudit.rows,expected.evidenceRows);}
 assert.equal(end.stopped.restored,true);assert.equal(end.stopped.bindingRestored,true);assert.equal(end.stopped.activeDepth,0);assert.equal(end.stopped.readQueue.inFlight,false);assert.equal(end.stopped.readQueue.ticket,null);
 assert.equal(end.stopped.retainedRowBytes,0);assert.equal(end.stopped.metadataErrors,0);assert.equal(end.guard.sourceWritesDenied,0);assert.equal(end.readFailures,0);
 assert.ok(Object.values(end.owners).every(Boolean));save();if(collectError)throw collectError;return end;
}
try{
 const planFile=path.join(output,'plan.private.json'),planFd=fs.openSync(planFile,'wx',0o600);try{fs.writeSync(planFd,JSON.stringify({candidate:report.candidate,source,driver:report.driver,fixedOrder:report.fixedOrder,expected,readCpuLimitMs:300000,maxWallMs,maximumElectronHosts:7,maximumConcurrentElectronHosts:2}));fs.fdatasyncSync(planFd);}finally{fs.closeSync(planFd);}
 assert.deepEqual(report.production,baseline.production);expectedSource=currentSource();report.sourceBefore={sha256:expectedSource.sha256,files:expectedSource.entries.length};
 const manifest=read(path.join(path.dirname(option('--baseline')),'source-epoch-0','manifest.private.json'));assert.equal(hash(JSON.stringify(manifest.manifest)),manifest.receipt.manifestSha256);
 let verified=0,fences=0;for(const entry of manifest.manifest){const file=path.join(base.fixtureRoot,entry.label,entry.relative);
  if(entry.kind==='fence-directory'){assert.equal(fs.statSync(file).isDirectory(),true);assert.equal(fs.readdirSync(file).length,0);fences++;continue;}
  assert.equal(fs.statSync(file).size,entry.size);assert.equal(fileSha(file),entry.sha256);verified++;}
 report.inputManifest={sha256:manifest.receipt.manifestSha256,verifiedContentFiles:verified,emptyFenceDirectories:fences};assert.equal(currentSource().sha256,expectedSource.sha256);
 const index=path.join(base.fixtureRoot,'goal-plans','evidence-index.jsonl');indexSha=hash(fs.readFileSync(index));report.indexSha256=indexSha;counter=await startE3Counter();report.counterRuntime=counter.ready;
 const refRecord=report.reference={label:'reference',tickets:[],readCpuMs:0};reference=await launch('reference',refRecord);
 for(let i=0;i<8;i++)await readTicket(reference,'dense','reference-warm-'+i);
 for(const record of report.targets){
  budget();record.status='launching';save();
  try{
   target=await launch(record.label,record);for(let i=0;i<8;i++)await readTicket(target,'dense','target-warm-'+i);
   const f0=await checkpoint(record,{},'F0');if(!qualifiedE3Fast(f0)){record.status='invalid-before-exposure';record.reason=f0.gate.reason||f0.gate.status;continue;}
   const f1=await checkpoint(record,f0.gate,'F1');if(!qualifiedE3FastPair(f0,f1)){record.status='invalid-before-exposure';record.reason=f1.gate.reason||'fast_pair_unstable';continue;}
   record.fastPairQualified=true;record.status='exposing';save();
   const exposure=await readTicket(target,record.arm==='treatment'?'order-index-first':'order-supervisor-first','exposure');record.exposure=exposure;
   assert.equal(exposure.rows.filter(r=>r.readKind==='exposure-index').length,8);assert.equal(exposure.rows.filter(r=>r.readKind==='exposure-supervisor').length,1);assert.ok(exposure.rows.every(r=>r.heapBefore===null&&r.heapAfter===null));assert.ok(exposure.rows.filter(r=>r.readKind==='exposure-index').every(r=>r.rows===expected.evidenceRows&&r.outputSha256===undefined));
   record.firstWitness={mainA:await readTicket(target,'witness','post-exposure-first'),reference:await readTicket(reference,'witness','post-exposure-reference'),mainB:await readTicket(target,'witness','post-exposure-second')};
   const q1=await checkpoint(record,f1.gate,'Q1'),q2=await checkpoint(record,q1.gate,'Q2');record.formed=q1.gate.status==='suspect'&&q2.gate.status==='confirmed-transition';
   record.status=record.formed?'formed':qualifiedE3Dense(q1)&&qualifiedE3Dense(q2)?'valid-no-formation':'invalid-after-exposure';
  }catch(error){record.status='failed';record.failure={name:error.name,message:error.message};throw error;}
  finally{if(target){await close(target);target=null;}save();}
 }
 await close(reference);reference=null;const audited=report.targets.map(t=>t.exit?.postMeasurementAudit?.sha256).filter(Boolean);audited.push(report.reference.exit.postMeasurementAudit.sha256);assert.equal(new Set(audited).size,1);report.evidenceSemanticSha256=audited[0];
 const after=currentSource();report.sourceUnchanged=after.sha256===expectedSource.sha256;assert.equal(report.sourceUnchanged,true);report.sourceAfter={sha256:after.sha256,files:after.entries.length};
 report.samplerUnchanged=JSON.stringify(source)===JSON.stringify(e3SourceIdentity());report.driverUnchanged=JSON.stringify(report.driver)===JSON.stringify(driverIdentity());report.productionUnchanged=JSON.stringify(report.production)===JSON.stringify(productionIdentity(base.moduleRoot));assert.ok(report.samplerUnchanged&&report.driverUnchanged&&report.productionUnchanged);
 report.orderHypothesisSupported=report.targets.filter(t=>t.arm==='treatment').every(t=>t.status==='formed')&&report.targets.filter(t=>t.arm==='control').every(t=>t.status==='valid-no-formation');report.mechanicsOk=true;
 report.pairs=[1,2,3].map(i=>{const c=report.targets.find(t=>t.label==='C'+i),t=report.targets.find(t=>t.label==='T'+i);return {pair:i,control:c.status,treatment:t.status,valid:[c,t].every(x=>['formed','valid-no-formation'].includes(x.status))};});
 report.validPairs=report.pairs.filter(p=>p.valid).length;report.hypothesisConclusion=report.orderHypothesisSupported?'laboratory-candidate-needs-field-chain':report.validPairs===3?'not-reproduced-as-stable-effect-for-this-dose':'insufficient-qualified-pairs';
}catch(error){report.failures.push({name:error.name,message:error.message,stack:error.stack});process.exitCode=1;}
finally{
 for(const host of[...activeHosts])try{await close(host);}catch(error){report.failures.push({name:error.name,message:error.message});}
 if(counter)report.counterExit=await counter.close();report.finishedAt=new Date().toISOString();report.elapsedMs=Date.now()-began;report.journalBytes=journalBytes;report.readCpuOvershootMs=Math.max(0,report.readCpuMs-report.readCpuLimitMs);
 if(report.readCpuOvershootMs>0){report.mechanicsOk=false;report.failures.push({message:'e3_order_read_cpu_budget_exceeded'});process.exitCode=1;}save();
 console.log(JSON.stringify({mechanicsOk:report.mechanicsOk,orderHypothesisSupported:report.orderHypothesisSupported,ownedLaunches:report.ownedLaunches,readCpuMs:report.readCpuMs,targets:report.targets.map(t=>({label:t.label,arm:t.arm,status:t.status,reason:t.reason})),failures:report.failures.map(e=>e.message)}));
}
