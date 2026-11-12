import fs from 'node:fs';import path from 'node:path';import {spawn,execFileSync}from'node:child_process';
import{createRequire}from'node:module';import{createHash}from'node:crypto';import{createInterface}from'node:readline';import{pathToFileURL}from'node:url';
import{createDenseResidualProbe}from'./ri00/dense-residual-probe.mjs';import{advanceDenseResidual}from'./ri00/dense-residual.mjs';
import{readPortReferences}from'./ri00/inspector-read-ports.mjs';import{browserMainCounterDelta}from'./ri00/thread-counter-delta.mjs';
import{inspectClosure}from'./ri00/trace.mjs';import{productionIdentity,resolveDestination}from'./ri00/identity.mjs';
const args=process.argv.slice(2),option=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const ownedMain=args.includes('--fixture-main'),simulate=Number(option('--simulate-residual','0'));
const syntheticAdapter=args.includes('--simulate-adapter');
const forceCanaryActions=args.includes('--validate-trigger-actions');
const durationMs=Number(option('--duration-ms','1200000')),intervalMs=Number(option('--interval-ms','420000')),pid=Number(option('--pid','0')),port=Number(option('--port','0'));
if(!Number.isInteger(durationMs)||durationMs<1000||durationMs>1200000||!Number.isInteger(intervalMs)||intervalMs<1000||intervalMs>420000
  ||(!ownedMain&&(durationMs!==1200000||intervalMs!==420000))||![0,30,60].includes(simulate)||simulate&&!ownedMain||syntheticAdapter&&(!ownedMain||!simulate)||forceCanaryActions&&(!ownedMain||!syntheticAdapter))throw Error('bounded_dense_watch_configuration_required');
for(const key of['--module-root','--fixture-root','--coordination-root','--parent-hash','--output'])if(!option(key))throw Error('explicit_dense_source_required');
if(!ownedMain&&(!Number.isInteger(pid)||pid<1||!Number.isInteger(port)||port<1024||port>65535))throw Error('existing_main_identity_required');
const moduleRoot=fs.realpathSync(option('--module-root')),fixtureRoot=fs.realpathSync(option('--fixture-root')),coordinationLiveRoot=fs.realpathSync(option('--coordination-root')),
  output=resolveDestination(option('--output')),sourceRoot=path.dirname(coordinationLiveRoot);
if(fs.existsSync(output)||output===sourceRoot||output.startsWith(sourceRoot+path.sep)||output===fixtureRoot||output.startsWith(fixtureRoot+path.sep))throw Error('new_isolated_output_required');
fs.mkdirSync(output,{recursive:true,mode:0o700});
const wait=ms=>new Promise(r=>setTimeout(r,ms)),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),require=createRequire(path.join(moduleRoot,'apps/desktop/package.json'));
const report={kind:'persistent-dense-residual-formation-not-a-fix',synthetic:simulate>0,syntheticAdapter,forcedActionsForCanaryOnly:forceCanaryActions,ownedMain,startedAt:new Date().toISOString(),production:productionIdentity(moduleRoot),epochs:[],blocks:[],stream:[],failures:[],profiles:[],maxMainControlledCpuMs:30000};
const harness=()=>['capture-dense-residual.mjs','ri00/dense-residual-probe.mjs','ri00/dense-residual.mjs','ri00/inspector-read-ports.mjs','ri00/thread-counter-delta.mjs','ri00/darwin-process-counters.py','ri00/read-host.mjs','ri00/readonly-coordination.mjs','ri00/coordination-snapshot.mjs','ri00/trace.mjs','ri00/identity.mjs'].map(relative=>({relative,sha256:hash(fs.readFileSync(new URL(relative,import.meta.url)))}));report.harness=harness();
let actual,reference,counterProcess,counterReady,counterSeq=0,interrupted=false,gate={},actualOwnedInspector=false;
const counterPending=new Map(),children=[],sessions=[];
process.on('SIGINT',()=>{interrupted=true;});process.on('SIGTERM',()=>{interrupted=true;});
function connect(url){return new Promise((resolve,reject)=>{const ws=new WebSocket(url);ws.onerror=reject;ws.onopen=()=>{
  let sequence=0;const pending=new Map();const session={ws,post(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('dense_inspector_timeout:'+method));},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}};
  ws.onmessage=event=>{const x=JSON.parse(event.data),p=pending.get(x.id);if(!p)return;pending.delete(x.id);clearTimeout(p.timer);x.error?p.reject(Error('dense_inspector_reply:'+x.error.message)):p.resolve(x.result);};
  ws.onclose=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('dense_inspector_disconnected'));}pending.clear();};sessions.push(session);resolve(session);
};});}
function value(reply){if(reply.exceptionDetails)throw Error('dense_target_evaluation_failed');return reply.result.value;}
const evaluate=async(s,expression)=>value(await s.post('Runtime.evaluate',{expression,returnByValue:true}));
const invoke=async(s,method,values=[])=>value(await s.post('Runtime.callFunctionOn',{objectId:s.probe,functionDeclaration:'function(method,args){return this[method](...args);}',arguments:[{value:method},{value:values}],returnByValue:true,awaitPromise:true}));
function counterRead(id){return new Promise((resolve,reject)=>{const seq=++counterSeq,timer=setTimeout(()=>{counterPending.delete(seq);reject(Error('dense_counter_timeout'));},3000);counterPending.set(seq,{resolve,reject,timer});counterProcess.stdin.write(JSON.stringify({id:seq,pid:id})+'\n');});}
async function counters(){counterProcess=spawn('python3',[new URL('./ri00/darwin-process-counters.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
  let errors='';counterProcess.stderr.on('data',b=>{if(errors.length<16384)errors+=b;});counterProcess.once('close',()=>fs.writeFileSync(path.join(output,'counter-stderr.private.txt'),errors,{mode:0o600}));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('dense_counter_start_timeout')),5000);counterProcess.once('error',reject);
    createInterface({input:counterProcess.stdout}).on('line',line=>{const x=JSON.parse(line);if(x.ready){counterReady=x;clearTimeout(timer);resolve();return;}
      const p=counterPending.get(x.id);if(!p)return;counterPending.delete(x.id);clearTimeout(p.timer);x.ok?p.resolve(x.point):p.reject(Error('dense_counter_read_failed'));});});report.counterRuntime=counterReady;
}
function metadataIdentity(){const digest=createHash('sha256');let files=0;for(const dir of['goal-plans','conversations','projects']){
  const base=fs.realpathSync(path.join(sourceRoot,dir));const visit=(file,relative)=>{const s=fs.lstatSync(file,{bigint:true});
    if(s.isSymbolicLink()){digest.update(JSON.stringify([dir,relative,'link',fs.readlinkSync(file)]));return;}
    if(s.isDirectory()){for(const name of fs.readdirSync(file).sort())visit(path.join(file,name),path.join(relative,name));return;}
    files++;digest.update(JSON.stringify([dir,relative,...['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k]))]));};visit(base,'');}
  return {sha256:digest.digest('hex'),files};}
async function fixture(label){const dir=path.join(output,label);fs.mkdirSync(dir,{mode:0o700});const file=path.join(dir,'fixture.private.cjs'),ready=path.join(dir,'ready');
  const config={moduleRoot,fixtureRoot,coordinationLiveRoot,parentHash:option('--parent-hash'),sourceStores:true,bindings:true,desktopDiagnostics:false,output:dir};
  fs.writeFileSync(file,`const{app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir,'user-data'))});process.env.PEER_AGENT_HOME=${JSON.stringify(fixtureRoot)};process.env.PEER_AGENT_SLOW_TIMER_MS='0';app.whenReady().then(async()=>{
    const{guardReadOnlySource}=await import(${JSON.stringify(new URL('./ri00/readonly-coordination.mjs',import.meta.url).href)});const{createReadHost}=await import(${JSON.stringify(new URL('./ri00/read-host.mjs',import.meta.url).href)});const{createTrace}=await import(${JSON.stringify(new URL('./ri00/trace.mjs',import.meta.url).href)});
    globalThis.__ri00DenseGuard=guardReadOnlySource(${JSON.stringify(sourceRoot)});globalThis.__ri00DenseHost=await createReadHost({...${JSON.stringify(config)},readOnlyGuard:globalThis.__ri00DenseGuard,trace:createTrace({enabled:false})});
    globalThis.__ri00DenseDelay=0;
    ${syntheticAdapter?`const data=Array(69266).fill(Object.freeze({synthetic:true})),result=[{sessionId:'synthetic-control'}];const store={getStoreDir:()=>globalThis.__ri00DenseHost.readPorts.goalPlanStore.getStoreDir(),listEvidenceIndex(){const before=process.threadCpuUsage();while(process.threadCpuUsage().user-before.user<(2+globalThis.__ri00DenseDelay)*1000){for(let i=0;i<1000;i++)Math.imul(i,i+1);}return data;}};globalThis.__ri00DenseAdapter={goalPlanStore:store,supervisor:{list(){for(let i=0;i<12;i++)store.listEvidenceIndex();return result;}}};
    let warm=[null,null];for(let i=0;i<64&&require('v8').getHeapSpaceStatistics().find(s=>s.space_name==='new_space').space_size!==67108864;i++)warm[i%2]=Array.from({length:262144},(_,i)=>({i,text:String(i)}));warm=null;
    if(require('v8').getHeapSpaceStatistics().find(s=>s.space_name==='new_space').space_size!==67108864)throw Error('synthetic_adapter_heap_condition_not_ready');`:''}
    ${simulate&&!syntheticAdapter&&label==='owned-main'?`const store=globalThis.__ri00DenseHost.readPorts.goalPlanStore,original=store.listEvidenceIndex;store.listEvidenceIndex=function(...args){const result=Reflect.apply(original,this,args);const before=process.threadCpuUsage();while(process.threadCpuUsage().user-before.user<globalThis.__ri00DenseDelay*1000){for(let i=0;i<1000;i++)Math.imul(i,i+1);}return result;};`:''}
    setTimeout(()=>{globalThis.__ri00DenseHost.close();globalThis.__ri00DenseGuard.close();app.exit(0);},${durationMs+45000}).unref();
    require('fs').writeFileSync(${JSON.stringify(ready)},'ready');app.on('will-quit',()=>{globalThis.__ri00DenseHost.close();globalThis.__ri00DenseGuard.close();});}).catch(e=>{require('fs').writeFileSync(${JSON.stringify(path.join(dir,'error.private.txt'))},e.stack);app.exit(1)});`,{mode:0o600});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(require('electron'),['--inspect=0',...(syntheticAdapter?['--js-flags=--min-semi-space-size=32 --max-semi-space-size=32']:[]),file],{env,stdio:['ignore','pipe','pipe']});children.push(child);let stderr='',stdout='';child.stderr.on('data',b=>stderr+=b);child.stdout.on('data',b=>{if(stdout.length<1048576)stdout+=b;});
  for(let i=0;i<200&&(!fs.existsSync(ready)||!stderr.match(/ws:\/\/127\.0\.0\.1:\d+\//));i++)await wait(50);
  if(!fs.existsSync(ready))throw Error('dense_fixture_not_ready');const s=await connect(stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)[0]);s.pid=child.pid;s.owned=true;
  s.supervisor=(await s.post('Runtime.evaluate',{expression:'(globalThis.__ri00DenseAdapter||globalThis.__ri00DenseHost.readPorts).supervisor'})).result.objectId;s.store=(await s.post('Runtime.evaluate',{expression:'(globalThis.__ri00DenseAdapter||globalThis.__ri00DenseHost.readPorts).goalPlanStore'})).result.objectId;
  s.payload=await evaluate(s,'globalThis.__ri00DenseHost.payload');s.logs=()=>{fs.writeFileSync(path.join(dir,'stderr.private.txt'),stderr,{mode:0o600});fs.writeFileSync(path.join(dir,'stdout.private.txt'),stdout,{mode:0o600});};return s;
}
async function install(s){s.runtime=await evaluate(s,'({pid:process.pid,node:process.versions.node,electron:process.versions.electron,v8:process.versions.v8,cachedDataVersionTag:process.getBuiltinModule("v8").cachedDataVersionTag()})');if(s.runtime.pid!==s.pid)throw Error('dense_runtime_identity_mismatch');
  const directory=value(await s.post('Runtime.callFunctionOn',{objectId:s.store,functionDeclaration:'function(){return this.getStoreDir();}',returnByValue:true}));s.indexFile=path.join(directory,'evidence-index.jsonl');
  const p=await s.post('Runtime.callFunctionOn',{objectId:s.store,functionDeclaration:createDenseResidualProbe.toString(),arguments:[{objectId:s.supervisor},{value:s.payload},{value:{durationMs:Math.min(1200000,durationMs+30000),closeInspectorOnWatchdog:!s.owned&&actualOwnedInspector}}]});
  if(p.exceptionDetails||!p.result?.objectId)throw Error('dense_probe_install_failed');s.probe=p.result.objectId;s.birth=(await counterRead(s.pid)).values.ri_proc_start_abstime;
}
async function collect(s,label){const batch=await invoke(s,'take');report.stream.push({host:label,...batch});if(batch.state.stopped||batch.state.metadataErrors||batch.state.dropped||batch.state.gcDropped)throw Error('dense_probe_invalid_or_stopped');return batch;}
async function block(s,label){const points=[];
  const blockRecord={host:s===actual?'main':'reference',label,points,complete:false};report.blocks.push(blockRecord);
  for(let i=0;i<8;i++){
    if(interrupted)throw Error('dense_capture_interrupted');if(s===actual&&report.mainCpuMs>=30000)throw Error('dense_main_cpu_budget_exhausted');
    const before=await counterRead(s.pid),row=await invoke(s,'read',[label]),after=await counterRead(s.pid);
    if(before.values.ri_proc_start_abstime!==s.birth||after.values.ri_proc_start_abstime!==s.birth)throw Error('dense_os_process_replaced');
    const pmc=browserMainCounterDelta(before,after,counterReady.timebase,row.userMs+row.systemMs);points.push({row,pmc,before,after});
    if(s===actual){report.mainCpuMs+=row.userMs+row.systemMs;if(report.mainCpuMs>30000){report.mainBudgetOvershootMs=report.mainCpuMs-30000;throw Error('dense_main_cpu_budget_exhausted');}}await wait(150);
  }
  const calibration=[];for(let i=0;i<3;i++)calibration.push(await invoke(s,'native'));
  const batch=await collect(s,s===actual?'main':'reference'),rows=batch.rows.filter(r=>r.origin==='controlled'&&r.label===label);
  if(rows.length!==8)throw Error('dense_checkpoint_row_loss');for(let i=0;i<8;i++)points[i].row=rows[i];blockRecord.complete=true;blockRecord.calibration=calibration;return {points,calibration};
}
async function profileCandidate(s,label){let running=false;await s.post('Profiler.enable');try{await s.post('Profiler.setSamplingInterval',{interval:500});await s.post('Profiler.start');running=true;
    const rows=[];for(let i=0;i<3;i++){if(s===actual&&report.mainCpuMs>=30000)throw Error('dense_main_cpu_budget_exhausted');const row=await invoke(s,'read',['profile-'+label]);rows.push(row);if(s===actual){report.mainCpuMs+=row.userMs+row.systemMs;if(report.mainCpuMs>30000){report.mainBudgetOvershootMs=report.mainCpuMs-30000;throw Error('dense_main_cpu_budget_exhausted');}}}
    const {profile}=await s.post('Profiler.stop');running=false;fs.writeFileSync(path.join(output,label+'.private.cpuprofile'),JSON.stringify(profile),{mode:0o600});report.profiles.push({label,rows,instrumented:true,notUsedForDetection:true});
  }finally{if(running)await s.post('Profiler.stop').catch(()=>{});await s.post('Profiler.disable');}}
async function interferenceControl(){report.interference={blocks:[],naturalObservationGapAcknowledged:true,rootCpuOnlyNotNormalizationAttribution:true};
  for(const mode of['bare','detailed'])for(const [label,s]of[['main',actual],['reference',reference]]){
    await invoke(s,'setDetail',[mode]);const block={host:label,mode,points:[]};report.interference.blocks.push(block);
    try{for(let i=0;i<3;i++){
      if(s===actual&&report.mainCpuMs>=30000)throw Error('dense_main_cpu_budget_exhausted');const before=await counterRead(s.pid),row=await invoke(s,'read',['interference-'+mode]),after=await counterRead(s.pid);block.points.push({row,pmc:browserMainCounterDelta(before,after,counterReady.timebase,row.userMs+row.systemMs)});
      if(s===actual){report.mainCpuMs+=row.userMs+row.systemMs;if(report.mainCpuMs>30000){report.mainBudgetOvershootMs=report.mainCpuMs-30000;throw Error('dense_main_cpu_budget_exhausted');}}await wait(150);
    }}finally{await invoke(s,'setDetail',['detailed']);await collect(s,label);}
  }
}
async function postProfileControl(){report.postProfile=[];for(const[label,s]of[['main',actual],['reference',reference]]){
  const rows=[];report.postProfile.push({host:label,rows,instrumentedProfiler:false});for(let i=0;i<3;i++){
    if(s===actual&&report.mainCpuMs>=30000)throw Error('dense_main_cpu_budget_exhausted');const before=await counterRead(s.pid),row=await invoke(s,'read',['post-profile']),after=await counterRead(s.pid);rows.push({row,pmc:browserMainCounterDelta(before,after,counterReady.timebase,row.userMs+row.systemMs)});
    if(s===actual){report.mainCpuMs+=row.userMs+row.systemMs;if(report.mainCpuMs>30000){report.mainBudgetOvershootMs=report.mainCpuMs-30000;throw Error('dense_main_cpu_budget_exhausted');}}await wait(150);
  }await collect(s,label);
}}
try{
  if(!ownedMain){
    const exe=execFileSync('ps',['-p',String(pid),'-o','comm='],{encoding:'utf8'}).trim();if(exe!=='/Applications/Peer Agent.app/Contents/MacOS/Peer Agent')throw Error('dense_existing_app_mismatch');
    try{await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(500)});throw Error('dense_preexisting_inspector');}catch(e){if(e.message==='dense_preexisting_inspector')throw e;}
    process.kill(pid,'SIGUSR1');actualOwnedInspector=true;let targets;
    for(let i=0;i<50;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(500)})).json();break;}catch{await wait(100);}}
    if(execFileSync('/usr/sbin/lsof',['-nP',`-iTCP:${port}`,'-sTCP:LISTEN','-t'],{encoding:'utf8'}).trim()!==String(pid))throw Error('dense_inspector_owner_mismatch');
    actual=await connect(targets[0].webSocketDebuggerUrl);actual.pid=pid;const ports=await readPortReferences(actual.post.bind(actual));actual.supervisor=ports.find(x=>x.module==='SessionSupervisor').objectId;actual.store=ports.find(x=>x.module==='GoalPlanStore').objectId;
  }else actual=await fixture('owned-main');
  reference=await fixture('reference');actual.payload=reference.payload;await counters();await install(actual);await install(reference);report.mainRuntime=actual.runtime;report.referenceRuntime=reference.runtime;report.mainCpuMs=0;
  if(syntheticAdapter)for(const s of[actual,reference])for(let i=0;i<3;i++)await invoke(s,'native');
  const started=Date.now(),source=metadataIdentity(),index=hash(fs.readFileSync(actual.indexFile));report.sourceBefore={metadata:source,indexSha256:index};
  const identity=hash(JSON.stringify([actual.pid,actual.birth,reference.pid,reference.birth,source.sha256,index,actual.runtime,reference.runtime]));
  for(let epoch=0;epoch<(syntheticAdapter?5:3);epoch++){
    const due=started+epoch*intervalMs;
    while(Date.now()<due&&!interrupted){await wait(Math.min(5000,due-Date.now()));await collect(actual,'main');await collect(reference,'reference');}
    if(interrupted)throw Error('dense_capture_interrupted');
    if(simulate&&gate.baseline)await evaluate(actual,`globalThis.__ri00DenseDelay=${simulate}/12;true`);
    const before=metadataIdentity(),mainA=await block(actual,'epoch-'+epoch+'-a'),ref=await block(reference,'epoch-'+epoch+'-r'),mainB=await block(actual,'epoch-'+epoch+'-b'),after=metadataIdentity();
    const valid=before.sha256===source.sha256&&after.sha256===source.sha256&&hash(fs.readFileSync(actual.indexFile))===index
      &&[...mainA.points,...ref.points,...mainB.points].every(p=>p.pmc.available&&p.pmc.exclusiveWindow);
    const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)],calibrationRatios=[mainA,mainB].map(block=>median(block.calibration.map(c=>c.userMs+c.systemMs))/median(ref.calibration.map(c=>c.userMs+c.systemMs)));
    const calibrationStable=(report.baselineCalibration?calibrationRatios.every((r,i)=>Math.abs(r/report.baselineCalibration[i]-1)<=.10):Math.abs(calibrationRatios[0]/calibrationRatios[1]-1)<=.10)
      &&[mainA,ref,mainB].every(block=>median(block.points.map(p=>p.row.metadataCpuMs))<=2);
    gate=advanceDenseResidual(gate,{identity,valid,calibrationStable,mainA:mainA.points.map(p=>p.row),reference:ref.points.map(p=>p.row),mainB:mainB.points.map(p=>p.row)});
    if(gate.baseline&&!report.baselineCalibration)report.baselineCalibration=calibrationRatios;
    const checkpoint={epoch,relativeMs:Date.now()-started,mainA,reference:ref,mainB,calibrationRatios,calibrationStable,gate};report.epochs.push(checkpoint);
    fs.writeFileSync(path.join(output,'progress.private.json'),JSON.stringify({at:new Date().toISOString(),gate,epochs:report.epochs.length,mainCpuMs:report.mainCpuMs}),{mode:0o600});
    console.log(JSON.stringify({epoch,status:gate.status,reason:gate.reason,deltas:gate.deltas,mainCpuMs:report.mainCpuMs}));
    if(gate.status==='invalidated')throw Error('dense_comparison_invalidated:'+gate.reason);
    if((gate.status==='confirmed-transition'||gate.status==='slow-at-entry'||forceCanaryActions&&epoch===2)&&!report.profiles.length){await interferenceControl();await profileCandidate(actual,'candidate-main');await profileCandidate(reference,'candidate-reference');await postProfileControl();}
    if(gate.status==='confirmed-transition'||forceCanaryActions&&epoch===2)break;
  }
  if(!ownedMain&&!gate.status.startsWith('confirmed')&&gate.status!=='slow-at-entry')while(Date.now()-started<durationMs-30000&&!interrupted){await wait(Math.min(5000,durationMs-30000-(Date.now()-started)));await collect(actual,'main');await collect(reference,'reference');}
  report.sourceAfter={metadata:metadataIdentity(),indexSha256:hash(fs.readFileSync(actual.indexFile))};report.sourceUnchangedForWholeCapture=JSON.stringify(report.sourceBefore)===JSON.stringify(report.sourceAfter);report.gate=gate;
}catch(error){report.failures.push(error.message);}
finally{
  for(const[label,s]of[['main',actual],['reference',reference]])if(s?.probe)try{report.stream.push({host:label,...await invoke(s,'take')});s.stopped=await invoke(s,'stop');}catch(e){report.failures.push('cleanup-'+label+':'+e.message);}
  report.restoration={main:actual?.stopped,reference:reference?.stopped};
  if(reference)try{report.referenceGuard=await evaluate(reference,'({...globalThis.__ri00DenseGuard.state,readFailures:globalThis.__ri00DenseHost.readFailures()})');}catch(e){report.failures.push('reference_guard:'+e.message);}
  if(actual?.owned)try{report.mainGuard=await evaluate(actual,'({...globalThis.__ri00DenseGuard.state,readFailures:globalThis.__ri00DenseHost.readFailures()})');}catch(e){report.failures.push('main_guard:'+e.message);}
  if(actual&&!actual.owned&&actualOwnedInspector)await evaluate(actual,'setTimeout(()=>process.getBuiltinModule("inspector").close(),250);true').catch(e=>report.failures.push('inspector_close:'+e.message));
  for(const s of sessions)s.ws.close();for(const s of[actual,reference])s?.logs?.();
  for(const child of children){child.kill('SIGTERM');await new Promise(r=>child.exitCode==null&&child.signalCode==null?child.once('close',r):r());}
  if(counterProcess){counterProcess.stdin.end();counterProcess.kill('SIGTERM');}
  report.closeCheck=await inspectClosure(port,{required:actualOwnedInspector});report.harnessUnchanged=JSON.stringify(report.harness)===JSON.stringify(harness());report.productionUnchanged=JSON.stringify(report.production)===JSON.stringify(productionIdentity(moduleRoot));
  report.ok=!report.failures.length&&actual?.stopped?.restored&&reference?.stopped?.restored&&report.harnessUnchanged&&report.productionUnchanged&&(!actualOwnedInspector||report.closeCheck.closed)&&report.referenceGuard?.sourceWritesDenied===0&&report.referenceGuard?.readFailures===0&&(!ownedMain||report.mainGuard?.sourceWritesDenied===0&&report.mainGuard?.readFailures===0);
  report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report),{mode:0o600});console.log(JSON.stringify({ok:report.ok,status:gate.status,failures:report.failures,closed:report.closeCheck.closed}));if(!report.ok)process.exitCode=1;
}
