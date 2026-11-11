import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readPortReferences } from './ri00/inspector-read-ports.mjs';
import { readMicroprobe } from './ri00/read-microprobe.mjs';
import os from 'node:os';

const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const pid=Number(option('--pid')),port=Number(option('--port','9229'));
if(!Number.isInteger(pid)||pid<1||!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_target');
const moduleRoot=path.resolve(option('--module-root',fileURLToPath(new URL('../../..',import.meta.url))));
const fixtureRoot=fs.realpathSync(option('--fixture-root','')),output=option('--output');
if(!option('--fixture-root')||!output||!fs.existsSync(output)||fs.readdirSync(output).length)throw new Error('explicit_isolated_fixture_and_empty_output_required');
const personalRoot=path.join(os.homedir(),'.peer-agent'),actualOutput=fs.realpathSync(output);
if([fixtureRoot,actualOutput].some(value=>value===personalRoot||value.startsWith(personalRoot+path.sep))
  ||actualOutput===fixtureRoot||actualOutput.startsWith(fixtureRoot+path.sep))throw new Error('isolated_fixture_and_output_required');
fs.chmodSync(output,0o700);
const require=createRequire(path.join(moduleRoot,'apps/desktop/package.json'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hashes=()=>['compare-runtime-context.mjs','ri00/read-microprobe.mjs','ri00/inspector-read-ports.mjs','ri00/readonly-coordination.mjs','ri00/identity.mjs'].map(relative=>({relative,
  sha256:createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')}));
const report={kind:'controlled-read-only-context-comparison-not-natural-input',startedAt:new Date().toISOString(),harness:hashes(),
  sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:moduleRoot,encoding:'utf8'}).trim(),failures:[]};
let child,main,fixture,verifiedTarget=false;
async function connect(url){
  const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let sequence=0;const pending=new Map();
  socket.onmessage=event=>{const reply=JSON.parse(event.data),request=pending.get(reply.id);if(!request)return;
    pending.delete(reply.id);clearTimeout(request.timer);reply.error?request.reject(new Error(reply.error.message)):request.resolve(reply.result);};
  socket.onclose=()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('inspector_disconnected'));}pending.clear();};
  return{socket,post(method,params={}){return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`inspector_timeout:${method}`));},20000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });}};
}
async function call(session,id,fn){
  const reply=await session.post('Runtime.callFunctionOn',{objectId:id,functionDeclaration:fn.toString(),returnByValue:true});
  if(reply.exceptionDetails||reply.result?.subtype==='error')throw new Error('controlled_read_evaluation_failed');
  return reply.result.value;
}
try{
  // Attach to an already-open inspector; never signal, launch or restart the user's application.
  const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(1000)})).json();
  main=await connect(targets[0].webSocketDebuggerUrl);
  const identity=await main.post('Runtime.evaluate',{expression:'({pid:process.pid,electron:process.versions.electron})',returnByValue:true});
  if(identity.exceptionDetails||identity.result?.value?.pid!==pid||!identity.result.value.electron)throw new Error('target_pid_or_host_mismatch');
  verifiedTarget=true;
  const ports=await readPortReferences(main.post.bind(main)),store=ports.find(row=>row.module==='GoalPlanStore').objectId;
  const sourceDir=await call(main,store,function(){return this.getStoreDir();});
  report.mainA=await call(main,store,readMicroprobe);
  const file=path.join(output,'fixture.private.cjs'),ready=path.join(output,'ready');
  fs.writeFileSync(file,`const{app}=require('electron');const fs=require('node:fs');
    app.setPath('userData',${JSON.stringify(path.join(output,'user-data'))});
    process.env.PEER_AGENT_HOME=${JSON.stringify(fixtureRoot)};process.env.PEER_AGENT_SLOW_TIMER_MS='0';
    app.whenReady().then(async()=>{
      const{guardReadOnlySource}=await import(${JSON.stringify(new URL('./ri00/readonly-coordination.mjs',import.meta.url).href)});
      global.__ri00Guard=guardReadOnlySource(${JSON.stringify(path.dirname(sourceDir))});
      const{createGoalPlanStore}=await import(${JSON.stringify(pathToFileURL(path.join(moduleRoot,'packages/runtime-node/dist/goal-plan-store.mjs')).href)});
      const{recordDiagnosticPhase}=await import(${JSON.stringify(pathToFileURL(path.join(moduleRoot,'apps/desktop/electron/main/slow-timer-probe.mjs')).href)});
      const{setDiagnosticPhaseObserver}=await import(${JSON.stringify(pathToFileURL(path.join(moduleRoot,'packages/runtime-node/dist/diagnostic-phase.mjs')).href)});
      setDiagnosticPhaseObserver((name,fields)=>recordDiagnosticPhase(name,fields));
      global.__ri00MicroStore=createGoalPlanStore({storeDir:${JSON.stringify(sourceDir)}});
      fs.writeFileSync(${JSON.stringify(ready)},'ready');
    }).catch(error=>{fs.writeFileSync(${JSON.stringify(path.join(output,'fixture-error.private.txt'))},error.stack);app.exit(1)});`,{mode:0o600});
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  child=spawn(require('electron'),['--inspect=0',file],{env,stdio:['ignore','ignore','pipe']});
  let log='';child.stderr.on('data',data=>{log+=data;});
  for(let i=0;i<200&&(!fs.existsSync(ready)||!log.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/));i++)await wait(50);
  if(!fs.existsSync(ready))throw new Error('fixture_not_ready');
  fixture=await connect(log.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)[0]);
  const reference=await fixture.post('Runtime.evaluate',{expression:'global.__ri00MicroStore'});
  report.fixture=await call(fixture,reference.result.objectId,readMicroprobe);
  report.mainB=await call(main,store,readMicroprobe);
  report.dataMatched=['selectedNamesSha256','sourceStampsSha256','selectedFactsSha256'].every(key=>
    report.mainA[key]===report.fixture[key]&&report.mainB[key]===report.fixture[key]);
  report.ok=report.dataMatched;
}catch(error){report.failures.push(error.message);report.ok=false;}
finally{
  fixture?.socket.close();
  if(child){child.kill('SIGTERM');await new Promise(resolve=>child.exitCode==null?child.once('close',resolve):resolve());}
  if(main){
    if(verifiedTarget&&args.includes('--close-inspector'))try{
      const reply=await main.post('Runtime.evaluate',{expression:'setTimeout(()=>process.getBuiltinModule("inspector").close(),250);true',returnByValue:true});
      if(reply.exceptionDetails)throw new Error('close_evaluation_failed');
    }catch(error){report.failures.push(error.message);}
    main.socket.close();
  }
  await wait(1000);
  try{await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(300)});report.inspectorClosed=false;}catch{report.inspectorClosed=true;}
  report.harnessUnchangedDuringRun=JSON.stringify(report.harness)===JSON.stringify(hashes());
  if(report.failures.length||!report.harnessUnchangedDuringRun||(verifiedTarget&&args.includes('--close-inspector')&&!report.inspectorClosed))report.ok=false;
  report.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report,null,2),{mode:0o600});
  console.log(JSON.stringify({ok:report.ok,dataMatched:report.dataMatched,inspectorClosed:report.inspectorClosed,failures:report.failures}));
  if(!report.ok)process.exitCode=1;
}
