import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{fileURLToPath}from'node:url';
import{startOwnedE3Host}from'./ri00/e3-owned-host.mjs';import{startAccountedE3Counter}from'./ri00/e3-accounted-counter.mjs';import{browserMainCounterDelta}from'./ri00/thread-counter-delta.mjs';import{decodePassWork}from'./ri00/pass-work.mjs';import{sourceInventory}from'./ri00/source-archive.mjs';import{productionIdentity}from'./ri00/identity.mjs';import{evaluatePassWorkTarget}from'./ri00/e3-pass-work-result.mjs';
const args=process.argv.slice(2),opt=k=>args[args.indexOf(k)+1];for(const k of['--config','--budget','--parent','--output','--counter-addon'])if(!args.includes(k))throw Error('pass_work_arguments');
const read=f=>JSON.parse(fs.readFileSync(f)),hash=b=>createHash('sha256').update(b).digest('hex'),base=read(opt('--config')),budget=read(opt('--budget')),parent=read(opt('--parent')),output=path.resolve(opt('--output')),addon=fs.realpathSync(opt('--counter-addon'));
assert.equal(budget.kind,'E3-N-frozen-before-execution');assert.equal(budget.newBudget.launches,3);assert.equal(budget.newBudget.replacements,0);
if(fs.existsSync(path.join(output,'claim.private.json')))throw Error('pass_work_slots_already_claimed');fs.mkdirSync(output,{recursive:true,mode:0o700});
const root=fileURLToPath(new URL('../../../',import.meta.url)),source=()=>fs.readdirSync(new URL('./ri00/',import.meta.url)).filter(n=>/\.(mjs|c|cjs|py)$/.test(n)).sort().map(n=>[n,hash(fs.readFileSync(new URL('./ri00/'+n,import.meta.url)))]).concat([['run-e3-pass-work-qualification.mjs',hash(fs.readFileSync(new URL(import.meta.url)))]]);
const report={kind:'E3-N-tools-not-field-cause',candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),budgetSha256:hash(fs.readFileSync(opt('--budget'))),parentSha256:hash(fs.readFileSync(opt('--parent'))),addonSha256:hash(fs.readFileSync(addon)),source:source(),production:productionIdentity(base.moduleRoot),startedAt:new Date().toISOString(),ownedLaunches:0,cases:[],readCpuMs:0,counterBoundaryCpuMs:0,failures:[],fieldStarted:false,profileStarted:false,passed:false};
fs.writeFileSync(path.join(output,'claim.private.json'),JSON.stringify({budgetSha256:report.budgetSha256,launches:3,replacements:0}),{flag:'wx',mode:0o600});
const began=Date.now(),cpuStart=process.cpuUsage(),cpu=()=>{const c=process.cpuUsage(cpuStart);return(c.user+c.system)/1000;},wait=ms=>new Promise(r=>setTimeout(r,ms));let host,counter,record,seq=0,journalBytes=0,interrupted=false;
for(const s of['SIGINT','SIGTERM'])process.on(s,()=>{interrupted=true;});
const save=()=>{const f=path.join(output,'report.private.json'),t=f+'.tmp',fd=fs.openSync(t,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(report));fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(t,f);};
const guard=()=>{if(interrupted)throw Error('pass_work_interrupted');if(Date.now()-began>810000||cpu()+(counter?.selfCpuMs||0)>20000||report.readCpuMs>90000||report.counterBoundaryCpuMs>1000)throw Error('pass_work_budget');};
function journal(value){const b=JSON.stringify(value)+'\n';journalBytes+=Buffer.byteLength(b);if(journalBytes>33554432)throw Error('pass_work_journal_budget');const fd=fs.openSync(path.join(output,'batches.private.jsonl'),'a',0o600);try{fs.writeFileSync(fd,b);fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}}
const epoch=()=>sourceInventory(base.fixtureRoot,path.dirname(path.dirname(base.coordinationSnapshot)));
async function launch(label,mode){guard();record={label,mode,status:'launching',points:[],blocks:[]};report.cases.push(record);report.ownedLaunches++;save();host=await startOwnedE3Host({...base,mode,output:path.join(output,label),label,epoch:'e3-n-owned',ownedCounterPath:addon,spyGetters:true,qualification:mode==='functional',allowExposure:true,hostDeadlineMs:240000,readCpuLimitMs:90000});record.pid=host.child.pid;record.runtime=host.ready.runtime;seq=0;}
async function point(label,kind='dense'){
 guard();await host.rpc('renew');const id=++seq,before=await counter.read(host.child.pid);await host.rpc('request',{id,kind,label});const ticket=await host.rpc('wait',{id}),after=await counter.read(host.child.pid);journal({label,ticket,before,after});
 const batch=await host.rpc('take');journal({label,batch}); // Durable before every ACK, including a failed original read.
 const rows=batch.rows.filter(r=>r.ticketId===id);await host.rpc('ackBatch');await host.rpc('ackTicket',{id});
 report.readCpuMs+=rows.reduce((n,r)=>n+r.userMs+r.systemMs,0);record.readCpuMs=(record.readCpuMs||0)+rows.reduce((n,r)=>n+r.userMs+r.systemMs,0);
 assert.equal(ticket.state,'completed');assert.equal(rows.length,1);const row=rows[0];assert.equal(batch.state.metadataErrors,0);assert.equal(batch.state.dropped,0);assert.equal(batch.state.gcDropped,0);
 const pmc=browserMainCounterDelta(before,after,counter.ready.timebase,row.userMs+row.systemMs),work=row.passWork.enabled?decodePassWork(row.passWork):null;
 if(work){report.counterBoundaryCpuMs+=work.counterCpuUpperMs;const main=after.threads.find(t=>t.category==='browser-main');assert.equal(row.passWork.values[0],main.id);}
 const p={label,row,pmc,work};record.points.push(p);save();guard();return p;
}
async function finish(){const end=await host.close({skipAudit:true});await host.closed;record.exit=end;host=null;assert.ok(Object.values(end.owners).every(Boolean));assert.equal(end.stopped.restored,true);assert.equal(end.stopped.bindingRestored,true);assert.equal(end.stopped.readQueue.inFlight,false);assert.equal(end.stopped.readQueue.ticket,null);assert.equal(end.stopped.retainedRowBytes,0);if(end.guard){assert.equal(end.guard.sourceWritesDenied,0);assert.equal(end.readFailures,0);}record.status='completed';save();}

try{
 const input=epoch();report.sourceBefore={sha256:input.sha256,files:input.entries.length};assert.equal(input.sha256,parent.sourceBefore.sha256);assert.deepEqual(report.production,parent.production);
 counter=await startAccountedE3Counter(fileURLToPath(new URL('./ri00/darwin-process-counters.py',import.meta.url)));report.counterRuntime=counter.ready;
 await launch('N0','functional');await host.rpc('passCounter',{enabled:true});const p=await point('functional-counter','witness');assert.equal(p.work.passes.length,12);assert.equal(p.row.heapBefore,null);
 await host.rpc('passCounter',{enabled:false});const off=await point('functional-off','witness');assert.equal(off.work,null);assert.equal(off.row.passWork.slots,0);
 const state=await host.rpc('inspect');assert.deepEqual(Object.values(state.getters),[0,0,0]);record.zeroHeapGetters=true;await finish();
 for(const schedule of budget.schedule.production){await launch(schedule.label,'production');for(let i=0;i<8;i++)await point('warm-'+i);
  for(let block=0;block<4;block++){const enabled=schedule.modes[block];await host.rpc('passCounter',{enabled});const b={enabled,points:[],calibration:[]};record.blocks.push(b);
   for(let i=0;i<8;i++){b.points.push(await point('block-'+block+'-'+i));await wait(150);}for(let i=0;i<3;i++)b.calibration.push(await host.rpc('native'));save();}
  record.gate=evaluatePassWorkTarget(record,parent.expected);console.log(JSON.stringify({stage:record.label,gate:record.gate}));
  // Profiling requires a frozen, qualified implementation and BOTH counter targets to pass.
  // No speculative start here: host 1 cannot be kept alive beyond the one-host budget.
  record.profile={started:false,reason:'both-target-tool-gate-and-profile-controller-required'};
  await finish();
 }
 report.sourceUnchanged=epoch().sha256===report.sourceBefore.sha256;assert.equal(report.sourceUnchanged,true);report.driverUnchanged=JSON.stringify(source())===JSON.stringify(report.source);assert.equal(report.driverUnchanged,true);assert.deepEqual(productionIdentity(base.moduleRoot),report.production);
 report.toolGatePassed=report.cases.filter(r=>r.mode==='production').every(r=>r.gate?.passed);report.passed=report.toolGatePassed;
}catch(error){report.failures.push({name:error.name,message:error.message,stack:error.stack});process.exitCode=1;}
finally{
 if(host)try{record.cleanup=await host.close({skipAudit:true});await host.closed;host=null;record.readCpuMs=Math.max(record.readCpuMs||0,record.cleanup.stopped?.controlledCpuMs||0);report.readCpuMs=report.cases.reduce((n,r)=>n+(r.readCpuMs||0),0);}catch(error){report.failures.push({message:error.message});}
 if(counter){report.counterExit=await counter.close();if(!report.counterExit.known)report.failures.push({message:'pass_work_counter_cost_unknown'});}
 report.controllerCpuMs=cpu();report.controllerAuxChargedMs=report.controllerCpuMs+(report.counterExit?.finalCpuMs||0)+1000;report.prepareCpuReserveMs=10000;report.elapsedMs=Date.now()-began;report.journalBytes=journalBytes;report.finishedAt=new Date().toISOString();
 function bytes(dir){return fs.readdirSync(dir,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?bytes(path.join(dir,e.name)):fs.lstatSync(path.join(dir,e.name)).size),0);}report.logicalOutputBytes=bytes(output);
 if(report.elapsedMs>900000||report.controllerAuxChargedMs>20000||report.readCpuMs>90000||report.counterBoundaryCpuMs>1000||report.logicalOutputBytes>134217728)report.failures.push({message:'pass_work_final_budget_exceeded'});
 if(report.failures.length)report.passed=false;if(!report.passed)process.exitCode=1;save();console.log(JSON.stringify({passed:report.passed,toolGatePassed:report.toolGatePassed,ownedLaunches:report.ownedLaunches,readCpuMs:report.readCpuMs,elapsedMs:report.elapsedMs,controllerAuxChargedMs:report.controllerAuxChargedMs,failures:report.failures.map(f=>f.message)}));
}
