import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';import {fileURLToPath,pathToFileURL} from 'node:url';
import {startAccountedE3Counter} from './ri00/e3-accounted-counter.mjs';import {browserMainCounterDelta} from './ri00/thread-counter-delta.mjs';
import {evaluateE3Checkpoint} from './ri00/e3-checkpoint.mjs';import {evaluateE3DrainTarget} from './ri00/e3-drain-result.mjs';import {productionIdentity,resolveDestination} from './ri00/identity.mjs';import {sourceInventory} from './ri00/source-archive.mjs';
const args=process.argv.slice(2),option=k=>args[args.indexOf(k)+1];for(const k of['--config','--budget','--parent','--entry-report','--entry-seal','--output'])if(!args.includes(k))throw Error('e3_drain_arguments_required');
const hash=b=>createHash('sha256').update(b).digest('hex'),read=f=>JSON.parse(fs.readFileSync(f)),base=read(option('--config')),budgetBytes=fs.readFileSync(option('--budget')),seal=JSON.parse(budgetBytes),parentBytes=fs.readFileSync(option('--parent')),parent=JSON.parse(parentBytes),entryBytes=fs.readFileSync(option('--entry-report')),entry=JSON.parse(entryBytes);
assert.equal(hash(parentBytes),seal.parentReceiptSha256);assert.match(parent.candidate,/^[a-f0-9]{40}$/);assert.equal(parent.candidate,'8cfb68f06529448e5cfa8701c83d832e088dbe14');assert.equal(entry.passed,true);assert.equal(entry.unknownCostGap,false);assert.equal(entry.ownedLaunches,2);assert.equal(entry.budgetSealSha256,hash(budgetBytes));assert.equal(seal.newBudget.K.targets,2);assert.equal(seal.newBudget.K.reference,1);
const entrySeal=read(option('--entry-seal'));assert.equal(hash(entryBytes),entrySeal.rawReceiptSha256);assert.equal(entry.candidate,entrySeal.candidate);
const output=resolveDestination(option('--output')),codeRoot=fileURLToPath(new URL('../../../',import.meta.url));if(fs.existsSync(output)||output.startsWith(fs.realpathSync(base.fixtureRoot)+path.sep)||output.startsWith(fs.realpathSync(base.moduleRoot)+path.sep))throw Error('e3_drain_isolated_output_required');
fs.writeFileSync(path.join(path.dirname(option('--parent')),'e3-drain-three-fixed-slot-claim.private.json'),JSON.stringify({budgetSealSha256:hash(budgetBytes),output,maximumLaunches:3}),{flag:'wx',mode:0o600});fs.mkdirSync(output,{recursive:true,mode:0o700});
const driverFiles=[new URL(import.meta.url),new URL('./ri00/e3-accounted-counter.mjs',import.meta.url),new URL('./ri00/e3-drain-result.mjs',import.meta.url),new URL('./ri00/e3-checkpoint.mjs',import.meta.url),new URL('./ri00/thread-counter-delta.mjs',import.meta.url),new URL('./ri00/source-archive.mjs',import.meta.url),new URL('./ri00/identity.mjs',import.meta.url)];
const driverIdentity=()=>driverFiles.map(file=>({relative:path.basename(file.pathname),sha256:hash(fs.readFileSync(file))}));
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).reduce((n,d)=>n+(d.isDirectory()?walk(path.join(dir,d.name)):fs.lstatSync(path.join(dir,d.name)).size),0);
const report={kind:'E3-single-variable-drain-qualification-not-residual-attribution',candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:codeRoot,encoding:'utf8'}).trim(),startedAt:new Date().toISOString(),
 parentReceiptSha256:hash(parentBytes),entryReceiptSha256:hash(entryBytes),entryPublicSealSha256:hash(fs.readFileSync(option('--entry-seal'))),budgetSealSha256:hash(budgetBytes),sealedSamplerCandidate:parent.candidate,sealedSamplerSource:parent.source,driver:driverIdentity(),production:productionIdentity(base.moduleRoot),
 carry:{entryControllerCpuMs:entry.controllerCpuMs,entryReadCpuMs:entry.readCpuMs,entryJournalBytes:fs.statSync(path.join(path.dirname(option('--entry-report')),'batches.private.jsonl')).size,entryLogicalBytes:walk(path.dirname(option('--entry-report')))},
 targets:[{label:'D1',schedule:['point','block','block','point'],status:'not-started',checkpoints:[],tickets:[]},{label:'D2',schedule:['block','point','point','block'],status:'not-started',checkpoints:[],tickets:[]}],
 readCpuMs:0,readCpuLimitMs:150000,ownedLaunches:0,preparationCpuReserveMs:5000,counterShutdownCpuReserveMs:1000,mechanicsOk:false,drainHypothesisSupported:false,fieldAttribution:false,failures:[]};
let counter,reference,target,interrupted=false,journalBytes=0,sequence=0,startOwned;const hosts=new Set(),began=Date.now(),controllerBefore=process.cpuUsage(),wait=ms=>new Promise(r=>setTimeout(r,ms)),bundle=path.join(output,'sealed-sampler');
process.on('SIGINT',()=>{interrupted=true;});process.on('SIGTERM',()=>{interrupted=true;});
const controllerCpu=()=>{const c=process.cpuUsage(controllerBefore);return(c.user+c.system)/1000;};
const save=()=>{const f=path.join(output,'report.tmp'),fd=fs.openSync(f,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(report));fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(f,path.join(output,'report.private.json'));};
function guard(){if(interrupted)throw Error('e3_drain_interrupted');if(Date.now()-began>=600000||Date.now()-began+entry.elapsedMs>=900000)throw Error('e3_drain_wall_budget');if(report.readCpuMs>=150000||report.readCpuMs+entry.readCpuMs>=180000)throw Error('e3_drain_read_cpu_budget');
 if(controllerCpu()+(counter?.selfCpuMs||0)+report.preparationCpuReserveMs+1000+entry.controllerCpuMs>=20000)throw Error('e3_drain_controller_aux_budget');}
function journal(name,value){const line=JSON.stringify(value)+'\n',bytes=Buffer.byteLength(line);if(journalBytes+bytes+report.carry.entryJournalBytes>33554432)throw Error('e3_drain_shared_journal_budget');const fd=fs.openSync(path.join(output,name),'a',0o600);try{fs.writeFileSync(fd,line);fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}journalBytes+=bytes;}
const currentSource=()=>sourceInventory(base.fixtureRoot,path.dirname(path.dirname(base.coordinationSnapshot)));let epoch,indexSha;
async function collect(host){const batch=await host.rpc('take');journal('batches.private.jsonl',{host:host.label,batch});assert.ok(Math.abs(batch.state.controlledCpuMs-host.cpu)<.001);assert.equal(batch.state.metadataErrors,0);assert.equal(batch.state.dropped,0);assert.equal(batch.state.gcDropped,0);assert.equal(batch.state.ledgerOverflows,0);await host.rpc('ackBatch');return batch;}
async function ticket(host,label,mode='point'){
 guard();await host.rpc('renew');const id=++host.nextId,before=await counter.read(host.child.pid);assert.equal(String(before.values.ri_proc_start_abstime),host.birth);
 await host.rpc('request',{id,kind:'dense',label,sourceEpoch:epoch.sha256});const completed=await host.rpc('wait',{id});assert.equal(completed.state,'completed');assert.equal(completed.completedRows.length,1);assert.equal(completed.stoppedDuringRun,false);
 const cpu=completed.completedRows[0].cpuMs;host.cpu+=cpu;report.readCpuMs+=cpu;host.record.readCpuMs=host.cpu;
 const after=await counter.read(host.child.pid);assert.equal(String(after.values.ri_proc_start_abstime),host.birth);const nativeId=++sequence;
 // Even block-drain mode persists the completed ticket and cost before releasing its one slot.
 journal('native-points.private.jsonl',{nativeId,host:host.label,id,completed,before,after});host.record.tickets.push({id,label,mode,nativeId,completed});
 const result={id,nativeId,pmc:browserMainCounterDelta(before,after,counter.ready.timebase,cpu)};
 if(mode==='point'){const batch=await collect(host);const rows=batch.rows.filter(r=>r.ticketId===id);assert.equal(rows.length,1);result.row=rows[0];}
 await host.rpc('ackTicket',{id});guard();return result;
}
async function block(host,label,mode){const result={label,mode,points:[],calibration:[]};for(let i=0;i<8;i++){result.points.push(await ticket(host,label+'-'+i,mode));await wait(150);}
 for(let i=0;i<3;i++){guard();result.calibration.push(await host.rpc('native'));}
 if(mode==='block'){const batch=await collect(host);assert.equal(batch.rows.length,8);for(const p of result.points){p.row=batch.rows.find(r=>r.ticketId===p.id);assert.ok(p.row);}}
 return result;
}
async function checkpoint(record,state,index,mode){const before=currentSource(),mainA=await block(target,'K'+index+'-a',mode),ref=await block(reference,'K'+index+'-r',mode),mainB=await block(target,'K'+index+'-b',mode),after=currentSource();
 const identity=hash(JSON.stringify([target.birth,reference.birth,epoch.sha256,indexSha,target.ready.runtime,reference.ready.runtime]));
 const result={index,mode,mainA,reference:ref,mainB,...evaluateE3Checkpoint(state,{identity,mainA,reference:ref,mainB,sourceStable:before.sha256===epoch.sha256&&after.sha256===epoch.sha256,expected:parent.expected})};
 record.checkpoints.push(result);save();console.log(JSON.stringify({target:record.label,index,mode,status:result.gate.status,reason:result.gate.reason,ranges:result.gate.summaries?.map(s=>s.compatibleRange),calibrationStable:result.calibrationStable,readCpuMs:report.readCpuMs}));return result;
}
async function launch(label,record){guard();report.ownedLaunches++;save();const host=await startOwned({...base,mode:'production',qualification:false,output:path.join(output,label),label,epoch:epoch.sha256,allowExposure:true,auditOnShutdown:true,hostDeadlineMs:label==='reference'?630000:180000,leaseMs:90000,readCpuLimitMs:300000});hosts.add(host);
 host.label=label;host.record=record;host.cpu=0;host.nextId=0;assert.equal(host.ready.pid,host.child.pid);const point=await counter.read(host.child.pid);host.birth=String(point.values.ri_proc_start_abstime);record.pid=host.child.pid;record.birth=host.birth;record.runtime=host.ready.runtime;
 for(const key of['node','electron','v8','cachedDataVersionTag'])assert.equal(host.ready.runtime[key],parent.reference.runtime[key]);assert.equal(hash(fs.readFileSync(host.ready.indexFile)),indexSha);return host;}
async function close(host){let collectError;try{await collect(host);}catch(error){collectError=error;}const end=await host.close({skipAudit:Boolean(collectError)||report.readCpuMs+1000>150000});await host.closed;hosts.delete(host);host.record.exit=end;report.readCpuMs+=end.postMeasurementAudit?.cpuMs||0;
 assert.equal(end.stopped.restored,true);assert.equal(end.stopped.bindingRestored,true);assert.equal(end.stopped.activeDepth,0);assert.equal(end.stopped.readQueue.ticket,null);assert.equal(end.stopped.readQueue.inFlight,false);assert.equal(end.stopped.retainedRowBytes,0);assert.ok(Object.values(end.owners).every(Boolean));assert.equal(end.guard.sourceWritesDenied,0);assert.equal(end.readFailures,0);assert.equal(end.postMeasurementAudit.rows,parent.expected.evidenceRows);assert.equal(end.postMeasurementAudit.sha256,parent.evidenceSemanticSha256);save();if(collectError)throw collectError;}
try{
 assert.deepEqual(report.production,parent.production);epoch=currentSource();assert.equal(epoch.sha256,parent.sourceBefore.sha256);report.sourceBefore={sha256:epoch.sha256,files:epoch.entries.length};
 const preparationBegan=Date.now(),archive=execFileSync('git',['archive','--format=zip',parent.candidate,'apps/desktop/scripts/ri00'],{cwd:codeRoot,timeout:5000,maxBuffer:1048576});
 const require=createRequire(path.join(codeRoot,'package.json')),Zip=require('adm-zip'),zip=new Zip(archive);fs.mkdirSync(bundle,{mode:0o700});
 for(const item of parent.source){assert.match(item.relative,/^[a-z0-9.-]+$/);const bytes=zip.readFile('apps/desktop/scripts/ri00/'+item.relative);assert.ok(bytes);assert.equal(hash(bytes),item.sha256);fs.writeFileSync(path.join(bundle,item.relative),bytes,{mode:0o600});}
 report.preparationWallMs=Date.now()-preparationBegan;assert.ok(report.preparationWallMs<=5000);({startOwnedE3Host:startOwned}=await import(pathToFileURL(path.join(bundle,'e3-owned-host.mjs')).href));
 const index=path.join(base.fixtureRoot,'goal-plans/evidence-index.jsonl');indexSha=hash(fs.readFileSync(index));assert.equal(indexSha,parent.indexSha256);
 counter=await startAccountedE3Counter(path.join(bundle,'darwin-process-counters.py'));report.counterRuntime=counter.ready;
 report.reference={label:'reference',tickets:[]};reference=await launch('reference',report.reference);for(let i=0;i<8;i++)await ticket(reference,'warm-reference-'+i);
 for(const r of report.targets){r.status='running';target=await launch(r.label,r);for(let i=0;i<8;i++)await ticket(target,'warm-target-'+i);let state={};
  for(let i=0;i<4;i++){const cp=await checkpoint(r,state,i,r.schedule[i]);state=cp.gate;}
  Object.assign(r,evaluateE3DrainTarget(r.checkpoints));r.status='completed';await close(target);target=null;
  const bytes=walk(output);report.logicalOutputBytes=bytes;if(bytes+report.carry.entryLogicalBytes+33554432>268435456)throw Error('e3_drain_output_budget');
 }
 await close(reference);reference=null;report.sourceUnchanged=currentSource().sha256===epoch.sha256;assert.equal(report.sourceUnchanged,true);
 report.productionUnchanged=JSON.stringify(productionIdentity(base.moduleRoot))===JSON.stringify(report.production);report.driverUnchanged=JSON.stringify(driverIdentity())===JSON.stringify(report.driver);assert.ok(report.productionUnchanged&&report.driverUnchanged);
 for(const item of parent.source)assert.equal(hash(fs.readFileSync(path.join(bundle,item.relative))),item.sha256);report.sealedSamplerUnchanged=true;
 assert.equal(hash(fs.readFileSync(option('--parent'))),report.parentReceiptSha256);assert.equal(hash(fs.readFileSync(option('--entry-report'))),report.entryReceiptSha256);assert.equal(hash(fs.readFileSync(option('--budget'))),report.budgetSealSha256);
 report.drainHypothesisSupported=report.targets.every(t=>t.supported);report.conclusion=report.drainHypothesisSupported?'drain-granularity-qualification-candidate-not-field-cause':'predeclared-sufficient-cause-criterion-not-supported';report.mechanicsOk=true;
}catch(error){report.failures.push({name:error.name,message:error.message,stack:error.stack});process.exitCode=1;}
finally{
 for(const host of[...hosts])try{await close(host);}catch(error){report.failures.push({name:error.name,message:error.message});try{await host.close();}catch{}hosts.delete(host);}
 if(counter){report.counterExit=await counter.close();if(!report.counterExit.known){report.mechanicsOk=false;report.failures.push({message:'counter-final-cost-unknown'});process.exitCode=1;}}
 report.elapsedMs=Date.now()-began;report.controllerCpuMs=controllerCpu();report.controllerAuxChargedMs=report.controllerCpuMs+(report.counterExit?.finalCpuMs||0)+5000+1000+entry.controllerCpuMs;report.journalBytes=journalBytes;report.finishedAt=new Date().toISOString();
 if(report.controllerAuxChargedMs>20000||report.readCpuMs>150000||report.elapsedMs>600000||report.readCpuMs+entry.readCpuMs>180000){report.mechanicsOk=false;report.failures.push({message:'e3_drain_final_budget_exceeded'});process.exitCode=1;}
 report.unknownCostGap=report.failures.some(f=>/timeout|disconnected|unknown|ready/i.test(f.message));if(report.failures.length)report.mechanicsOk=false;
 if(!report.mechanicsOk){report.supportPatternBeforeInvalidation=report.drainHypothesisSupported;report.drainHypothesisSupported=false;report.conclusion='invalidated-measurement-or-recovery';}save();
 console.log(JSON.stringify({mechanicsOk:report.mechanicsOk,drainHypothesisSupported:report.drainHypothesisSupported,ownedLaunches:report.ownedLaunches,readCpuMs:report.readCpuMs,controllerAuxChargedMs:report.controllerAuxChargedMs,conclusion:report.conclusion,failures:report.failures.map(f=>f.message)}));
}
