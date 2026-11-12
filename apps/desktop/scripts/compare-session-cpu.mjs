import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn,execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { controlledSessionRead } from './ri00/paired-read-cpu.mjs';
import { controlledCacheRead } from './ri00/cache-read-cpu.mjs';
import { createIndexCounterProbe } from './ri00/index-counter-probe.mjs';
import { readPortReferences } from './ri00/inspector-read-ports.mjs';
import { inspectClosure } from './ri00/trace.mjs';
import { resolveDestination,productionIdentity,fixtureIdentity,contentIdentity } from './ri00/identity.mjs';

const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const isolationOnly=args.includes('--isolation-only'),pid=Number(option('--pid','0')),port=Number(option('--port','9229'));
const mode=option('--mode','session');if(!['session','cache','counters'].includes(mode))throw new Error('invalid_comparison_mode');
if(isolationOnly&&mode!=='counters')throw new Error('isolation_requires_counter_mode');
const counterTarget=option('--counter-target','index'),counterRounds=Number(option('--counter-rounds','3')),counterIdleMs=Number(option('--counter-idle-ms','14500'));
if(!['index','session'].includes(counterTarget)||counterTarget==='session'&&!isolationOnly||!Number.isInteger(counterRounds)||counterRounds<3||counterRounds>9||!Number.isInteger(counterIdleMs)||counterIdleMs<20||counterIdleMs>15000)throw new Error('unbounded_counter_configuration');
if(args.includes('--clone-normalizers')&&mode!=='cache')throw new Error('clones_require_cache_comparison');
if((!isolationOnly&&(!Number.isInteger(pid)||pid<1))||!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_target');
for(const name of ['--module-root','--fixture-root','--output','--parent-hash'])if(!option(name))throw new Error('explicit_source_configuration_required');
if(Boolean(option('--coordination-root'))===Boolean(option('--coordination-snapshot')))throw new Error('one_coordination_source_required');
const moduleRoot=fs.realpathSync(option('--module-root')),fixtureRoot=fs.realpathSync(option('--fixture-root')),
  coordinationLiveRoot=option('--coordination-root')?fs.realpathSync(option('--coordination-root')):null,
  coordinationSnapshot=option('--coordination-snapshot')?fs.realpathSync(option('--coordination-snapshot')):null,output=resolveDestination(option('--output'));
const personal=resolveDestination(path.join(os.homedir(),'.peer-agent'));
if([fixtureRoot,output].some(root=>root===personal||root.startsWith(personal+path.sep))||output===fixtureRoot||output.startsWith(fixtureRoot+path.sep)
  ||fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('isolated_fixture_and_new_output_required');
fs.mkdirSync(output,{recursive:true,mode:0o700});fs.chmodSync(output,0o700);
const harness=()=>['compare-session-cpu.mjs','ri00/paired-read-cpu.mjs','ri00/cache-read-cpu.mjs','ri00/index-counter-probe.mjs','ri00/darwin-process-counters.py','ri00/read-host.mjs','ri00/inspector-read-ports.mjs','ri00/readonly-coordination.mjs','ri00/identity.mjs','ri00/trace.mjs'].map(relative=>({relative,
  sha256:createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')}));
const report={kind:isolationOnly?'isolated-hot-idle-hot-cpu-counters-not-a-fix':'controlled-main-child-main-session-cpu-not-a-fix',mode,isolationOnly,counterTarget,startedAt:new Date().toISOString(),harness:harness(),production:productionIdentity(moduleRoot),
  sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:moduleRoot,encoding:'utf8'}).trim(),failures:[]};
if(isolationOnly){report.fixtureIdentity=fixtureIdentity(fixtureRoot);report.snapshotIdentity=coordinationSnapshot?contentIdentity(coordinationSnapshot):null;}
const require=createRequire(path.join(moduleRoot,'apps/desktop/package.json')),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,main,fixture,verified=false,counterProcess,counterReady;
const counterPending=new Map();let counterSequence=0;
function counterRead(pid){return new Promise((resolve,reject)=>{const id=++counterSequence,timer=setTimeout(()=>{counterPending.delete(id);reject(new Error('counter_sidecar_timeout'));},3000);
  counterPending.set(id,{resolve,reject,timer});counterProcess.stdin.write(JSON.stringify({id,pid})+'\n');});}
async function startCounters(){
  counterProcess=spawn('python3',[new URL('./ri00/darwin-process-counters.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});
  let errorLog='';counterProcess.stderr.on('data',bytes=>{errorLog+=bytes;});
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('counter_sidecar_not_ready')),3000);
    createInterface({input:counterProcess.stdout}).on('line',line=>{const value=JSON.parse(line);if(value.ready){clearTimeout(timer);counterReady=value;resolve(value);return;}
      const pending=counterPending.get(value.id);if(!pending)return;counterPending.delete(value.id);clearTimeout(pending.timer);
      value.ok?pending.resolve(value.point):pending.reject(new Error(`counter_read_failed:${value.errno}`));});
    counterProcess.once('error',reject);counterProcess.once('exit',()=>{clearTimeout(timer);reject(new Error('counter_sidecar_exited'));});});
  await ready;report.counterRuntime=counterReady;counterProcess.once('close',()=>fs.writeFileSync(path.join(output,'counter-stderr.private.txt'),errorLog,{mode:0o600}));
}
async function connect(url){
  const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const reply=JSON.parse(event.data),request=pending.get(reply.id);if(!request)return;pending.delete(reply.id);clearTimeout(request.timer);
    reply.error?request.reject(new Error(reply.error.message)):request.resolve(reply.result);};
  socket.onclose=()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('inspector_disconnected'));}pending.clear();};
  return {socket,post(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('inspector_timeout'));},30000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}};
}
async function evaluate(session,expression,returnByValue=true){const reply=await session.post('Runtime.evaluate',{expression,returnByValue});
  if(reply.exceptionDetails)throw new Error('evaluation_failed');return reply.result;}
async function read(session,supervisor,store,payload){
  const reply=await session.post('Runtime.callFunctionOn',{objectId:supervisor,functionDeclaration:controlledSessionRead.toString(),
    arguments:[{objectId:store},{value:payload}],awaitPromise:true,returnByValue:true});
  if(reply.exceptionDetails)throw new Error('paired_read_failed');return reply.result.value;
}
async function cacheRead(session,store){
  const props=async objectId=>session.post('Runtime.getProperties',{objectId,ownProperties:true});
  const property=async(objectId,key)=>(await props(objectId)).result.find(row=>row.name===key)?.value.objectId;
  async function binding(objectId,key){
    const scopes=(await props(objectId)).internalProperties?.find(row=>row.name==='[[Scopes]]')?.value.objectId;
    if(!scopes)return;
    for(const row of (await props(scopes)).result){if(!/^\d+$/.test(row.name)||!row.value?.objectId)continue;
      const found=(await props(row.value.objectId)).result.find(value=>value.name===key);if(found)return found.value?.objectId;}
  }
  const warm=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:'function(){return this.listEvidenceIndex().length;}',returnByValue:true});
  if(warm.exceptionDetails||!warm.result.value)throw new Error('cache_priming_failed');
  let reader=await property(store,'listEvidenceIndex'),cache;
  for(let i=0;i<8;i++){cache=await binding(reader,'evidenceIndexReadCache');if(cache)break;reader=await binding(reader,'original');if(!reader)break;}
  if(!reader||!cache)throw new Error('production_evidence_cache_unavailable');
  const refs=[];for(const name of ['normalizeEvidenceIndexRecord','retainInteractiveEvidence','readJsonl']){
    const id=await binding(reader,name);if(!id)throw new Error('production_normalizer_binding_unavailable');refs.push({objectId:id});}
  const directory=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:'function(){return this.getStoreDir();}',returnByValue:true});
  if(directory.exceptionDetails)throw new Error('store_directory_unavailable');
  let dependencies;
  if(args.includes('--clone-normalizers')){
    const names=['normalizeOptionalString','normalizeInteractiveInspectionReceipt','interactiveInspectionEvidenceRef','normalizeEvidenceRefList','normalizeInteractiveUserArtifact'];
    const argumentsForFunctions=[];
    for(const name of names){const id=await binding(refs[0].objectId,name);if(!id)throw new Error('clone_dependency_unavailable');argumentsForFunctions.push({objectId:id});}
    const stringArray=await binding(argumentsForFunctions[3].objectId,'normalizeStringArray');if(!stringArray)throw new Error('string_array_dependency_unavailable');
    argumentsForFunctions.push({objectId:stringArray});
    const reply=await session.post('Runtime.callFunctionOn',{objectId:reader,functionDeclaration:'function(...functions){return functions;}',arguments:argumentsForFunctions});
    if(reply.exceptionDetails||!reply.result.objectId)throw new Error('clone_dependency_pack_failed');dependencies={objectId:reply.result.objectId};
  }
  const reply=await session.post('Runtime.callFunctionOn',{objectId:cache,functionDeclaration:controlledCacheRead.toString(),
    arguments:[...refs,{objectId:reader},{value:directory.result.value},...(dependencies?[dependencies]:[])],awaitPromise:true,returnByValue:true});
  if(reply.exceptionDetails)throw new Error('cache_comparison_failed');return reply.result.value;
}
async function counterModeRead(session,store,pid,options={}){
  const directory=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:'function(){return this.getStoreDir();}',returnByValue:true});
  if(directory.exceptionDetails)throw new Error('counter_store_directory_unavailable');
  const file=path.join(directory.result.value,'evidence-index.jsonl');
  const identity=()=>{const s=fs.statSync(file,{bigint:true});return {sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),stampSha256:createHash('sha256').update(JSON.stringify(
    ['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(s[key])))).digest('hex'),bytes:String(s.size)};};
  const target=isolationOnly?counterTarget:'index';
  const result={kind:'native-process-counters-around-controlled-read',target,delayMs:options.delayMs??100,sourceBefore:identity(),points:[],failures:[]};
  const created=await session.post('Runtime.callFunctionOn',{objectId:store,functionDeclaration:createIndexCounterProbe.toString(),
    arguments:target==='session'?[{objectId:options.supervisor},{value:options.payload}]:[]});
  if(created.exceptionDetails||!created.result.objectId)throw new Error('counter_probe_creation_failed');const probe=created.result.objectId;
  const invoke=async kind=>{const reply=await session.post('Runtime.callFunctionOn',{objectId:probe,functionDeclaration:'function(kind){return this.read(kind);}',arguments:[{value:kind}],returnByValue:true});
    if(reply.exceptionDetails)throw new Error('counter_probe_read_failed');return reply.result.value;};
  try{
    result.prime=await invoke(target);await wait(100);
    if(isolationOnly){result.warmReads=[];for(let i=0;i<6;i++){result.warmReads.push(await invoke(target));await wait(20);}}
    for(let round=0;round<counterRounds;round++){
      if(isolationOnly)await wait(result.delayMs);
      for(const kind of (isolationOnly?[target,'native','noop']:['noop','index','native','index','native','index'])){
      const before=await counterRead(pid),start=performance.now(),row=await invoke(kind),end=performance.now(),after=await counterRead(pid);
      result.points.push({round,row,before,after,transportWallMs:end-start});if(!isolationOnly)await wait(100);
      }
      if(isolationOnly&&result.delayMs>1000){const row=result.points.findLast(point=>point.round===round&&point.row.kind===target)?.row;
        console.log(JSON.stringify({counterRound:round,delayMs:result.delayMs,target,wallMs:row.end-row.start,userMs:row.threadUserMs,evidenceUserMs:row.evidence.reduce((sum,span)=>sum+span.userMs,0)}));}
    }
    result.ok=true;
  }catch(error){result.ok=false;result.failures.push(error.message);}
  finally{
    await wait(20);const stopped=await session.post('Runtime.callFunctionOn',{objectId:probe,functionDeclaration:'function(){return this.stop();}',returnByValue:true});
    if(stopped.exceptionDetails)throw new Error('counter_probe_cleanup_failed');result.observation=stopped.result.value;
    for(let i=0;i<result.points.length;i++){result.points[i].row=result.observation.reads[i+1+(result.warmReads?.length||0)];
      const p=result.points[i],delta={};for(const key of ['ri_user_time','ri_system_time','ri_instructions','ri_cycles',...Object.keys(p.before.values).filter(key=>key.startsWith('ri_cpu_time_qos_'))]){
        delta[key]=String(BigInt(p.after.values[key])-BigInt(p.before.values[key]));}
      p.delta=delta;p.processIdentityStable=p.before.values.ri_proc_start_abstime===p.after.values.ri_proc_start_abstime;
      p.nativeCpuMs=(Number(delta.ri_user_time)+Number(delta.ri_system_time))*counterReady.timebase.numer/counterReady.timebase.denom/1e6;
      p.outsideMeasuredProcessCpuMs=p.nativeCpuMs-p.row.processUserMs-p.row.processSystemMs;
    }
    result.sourceAfter=identity();result.sourceUnchanged=JSON.stringify(result.sourceBefore)===JSON.stringify(result.sourceAfter);
    result.readsValid=result.observation.reads.filter(row=>row.kind===target).every(row=>row.rows>0&&!row.readFailure
      &&(target!=='session'||row.evidence.length>0&&row.evidence.every(span=>span.rows>0)));
    result.countersAvailable=result.points.filter(point=>point.row.kind!=='noop').every(point=>BigInt(point.delta.ri_cycles)>0&&BigInt(point.delta.ri_instructions)>0);
    if(target==='session'){result.projectionMatched=new Set(result.observation.reads.filter(row=>row.kind==='session').map(row=>row.projectionSha256)).size===1;
      if(!result.projectionMatched)result.ok=false;}
    result.ok=result.ok&&result.readsValid&&result.countersAvailable&&result.sourceUnchanged&&result.observation.stopped&&result.observation.restored&&result.points.every(p=>p.processIdentityStable&&p.row.sourceStable&&p.row.sourceStamp===result.sourceBefore.stampSha256);
  }
  return result;
}
try{
  let supervisor,store;
  if(!isolationOnly){
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json();main=await connect(targets[0].webSocketDebuggerUrl);
  const identity=(await evaluate(main,'({pid:process.pid,electron:process.versions.electron,node:process.versions.node,uptime:process.uptime()})')).value;
  if(identity.pid!==pid||!identity.electron)throw new Error('main_pid_mismatch');verified=true;report.mainRuntime=identity;
  const ports=await readPortReferences(main.post.bind(main));supervisor=ports.find(row=>row.module==='SessionSupervisor').objectId;
  store=ports.find(row=>row.module==='GoalPlanStore').objectId;
  report.readPortDiscovery=ports.discovery;
  }
  const config={moduleRoot,fixtureRoot,coordinationLiveRoot,coordinationSnapshot,parentHash:option('--parent-hash'),output,sourceStores:Boolean(coordinationLiveRoot),bindings:true,desktopDiagnostics:false};
  const ready=path.join(output,'ready'),file=path.join(output,'fixture.private.cjs');
  fs.writeFileSync(file,`const{app}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(output,'user-data'))});
    process.env.PEER_AGENT_HOME=${JSON.stringify(fixtureRoot)};process.env.PEER_AGENT_SLOW_TIMER_MS='0';
    app.whenReady().then(async()=>{const{guardReadOnlySource}=await import(${JSON.stringify(new URL('./ri00/readonly-coordination.mjs',import.meta.url).href)});
    const{createReadHost}=await import(${JSON.stringify(new URL('./ri00/read-host.mjs',import.meta.url).href)});
    const{createTrace}=await import(${JSON.stringify(new URL('./ri00/trace.mjs',import.meta.url).href)});
    const guard=guardReadOnlySource(${JSON.stringify(coordinationLiveRoot?path.dirname(coordinationLiveRoot):fixtureRoot)});
    globalThis.__ri00CpuHost=await createReadHost({...${JSON.stringify(config)},readOnlyGuard:guard,trace:createTrace({enabled:false})});
    globalThis.__ri00CpuGuard=guard;fs.writeFileSync(${JSON.stringify(ready)},'ready');
    app.on('will-quit',()=>{globalThis.__ri00CpuHost.close();guard.close();});
    }).catch(error=>{fs.writeFileSync(${JSON.stringify(path.join(output,'fixture-error.private.txt'))},error.stack);app.exit(1)});`,{mode:0o600});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(require('electron'),['--inspect=0',file],{env,stdio:['ignore','ignore','pipe']});let log='';child.stderr.on('data',bytes=>{log+=bytes;});
  for(let i=0;i<200&&(!fs.existsSync(ready)||!log.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/));i++)await wait(50);
  fs.writeFileSync(path.join(output,'child-stderr.private.txt'),log,{mode:0o600});
  if(!fs.existsSync(ready))throw new Error('fixture_not_ready');fixture=await connect(log.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)[0]);
  const payload=(await evaluate(fixture,'globalThis.__ri00CpuHost.payload')).value;
  const childSupervisor=(await evaluate(fixture,'globalThis.__ri00CpuHost.readPorts.supervisor',false)).objectId,
    childStore=(await evaluate(fixture,'globalThis.__ri00CpuHost.readPorts.goalPlanStore',false)).objectId;
  const fixturePid=(await evaluate(fixture,'process.pid')).value;if(fixturePid!==child.pid)throw new Error('fixture_pid_mismatch');
  if(mode==='counters')await startCounters();
  if(isolationOnly){
    report.phases=[];
    for(const [name,delayMs]of [['hot-before',20],['idle',counterIdleMs],['hot-recovery',20]]){
      const phase=await counterModeRead(fixture,childStore,fixturePid,{supervisor:childSupervisor,payload,delayMs});report.phases.push({name,...phase});
      console.log(JSON.stringify({stage:name,ok:phase.ok,readWallMs:phase.points.filter(point=>point.row.kind===counterTarget).map(point=>point.row.end-point.row.start)}));
    }
    report.sourceMatched=report.phases.every(row=>row.ok&&row.sourceBefore.sha256===report.phases[0].sourceBefore.sha256&&row.sourceBefore.stampSha256===report.phases[0].sourceBefore.stampSha256);
    if(counterTarget==='session'){
      report.projectionMatched=new Set(report.phases.flatMap(phase=>phase.points.filter(point=>point.row.kind==='session').map(point=>point.row.projectionSha256))).size===1;
      if(!report.projectionMatched)report.sourceMatched=false;
    }
  }else{
  const compare=async(session,supervisor,store,payload,pid)=>mode==='session'?read(session,supervisor,store,payload):mode==='cache'?cacheRead(session,store):counterModeRead(session,store,pid);
  report.mainA=await compare(main,supervisor,store,payload,pid);
  report.fixture=await compare(fixture,childSupervisor,childStore,payload,fixturePid);
  report.mainB=await compare(main,supervisor,store,payload,pid);
  report.sourceMatched=[report.mainA,report.fixture,report.mainB].every(row=>row.ok&&row.sourceBefore.sha256===report.mainA.sourceBefore.sha256
    &&row.sourceBefore.stampSha256===report.mainA.sourceBefore.stampSha256);
  }
  report.fixtureGuard=(await evaluate(fixture,'({...globalThis.__ri00CpuGuard.state})')).value;
  report.fixtureReadFailures=(await evaluate(fixture,'globalThis.__ri00CpuHost.readFailures()')).value;
  report.ok=report.sourceMatched&&report.fixtureReadFailures===0&&report.fixtureGuard.sourceWritesDenied===0;
}catch(error){report.ok=false;report.failures.push({name:error.name,message:error.message});}
finally{
  if(counterProcess){for(const pending of counterPending.values()){clearTimeout(pending.timer);pending.reject(new Error('counter_sidecar_closing'));}counterPending.clear();counterProcess.stdin.end();counterProcess.kill('SIGTERM');}
  fixture?.socket.close();if(child){child.kill('SIGTERM');await new Promise(resolve=>child.exitCode==null?child.once('close',resolve):resolve());}
  if(main){if(verified&&args.includes('--close-inspector'))try{await evaluate(main,'setTimeout(()=>process.getBuiltinModule("inspector").close(),250);true');}
    catch(error){report.failures.push({name:error.name,message:'inspector_close_failed'});}main.socket.close();}
  report.closeCheck=await inspectClosure(port,{required:verified&&args.includes('--close-inspector')});
  report.harnessUnchanged=JSON.stringify(report.harness)===JSON.stringify(harness());report.productionUnchanged=JSON.stringify(report.production)===JSON.stringify(productionIdentity(moduleRoot));
  if(isolationOnly){report.fixtureUnchanged=JSON.stringify(report.fixtureIdentity)===JSON.stringify(fixtureIdentity(fixtureRoot));
    report.snapshotUnchanged=!coordinationSnapshot||JSON.stringify(report.snapshotIdentity)===JSON.stringify(contentIdentity(coordinationSnapshot));
    if(!report.fixtureUnchanged||!report.snapshotUnchanged)report.ok=false;}
  if(report.failures.length||!report.harnessUnchanged||!report.productionUnchanged||verified&&args.includes('--close-inspector')&&!report.closeCheck.closed)report.ok=false;
  report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({ok:report.ok,sourceMatched:report.sourceMatched,closeCheck:report.closeCheck,failures:report.failures}));if(!report.ok)process.exitCode=1;
}
