import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn,execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import vm from 'node:vm';
import { readPortReferences } from './ri00/inspector-read-ports.mjs';
import { fixtureIdentity,productionIdentity,contentIdentity,resolveDestination } from './ri00/identity.mjs';
import { inspectClosure } from './ri00/trace.mjs';

const args=process.argv.slice(2),option=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
for(const key of ['--module-root','--fixture-root','--coordination-snapshot','--parent-hash','--output'])if(!option(key))throw new Error('explicit_isolated_configuration_required');
const moduleRoot=fs.realpathSync(option('--module-root')),fixtureRoot=fs.realpathSync(option('--fixture-root')),snapshot=fs.realpathSync(option('--coordination-snapshot')),output=resolveDestination(option('--output'));
const personal=resolveDestination(path.join(os.homedir(),'.peer-agent'));
if([fixtureRoot,output].some(root=>root===personal||root.startsWith(personal+path.sep))||output===fixtureRoot||output.startsWith(fixtureRoot+path.sep)||fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('new_output_and_isolated_fixture_required');
fs.mkdirSync(output,{recursive:true,mode:0o700});fs.chmodSync(output,0o700);
const harness=()=>['perf-late-inspector.mjs','ri00/paired-read-cpu.mjs','ri00/read-microprobe.mjs','ri00/read-host.mjs','ri00/inspector-read-ports.mjs','ri00/trace.mjs','ri00/identity.mjs','ri00/readonly-coordination.mjs','ri00/coordination-snapshot.mjs'].map(relative=>({relative,sha256:createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')}));
const report={kind:'isolated-late-inspector-activation-not-a-fix',startedAt:new Date().toISOString(),harness:harness(),fixture:fixtureIdentity(fixtureRoot),snapshot:contentIdentity(snapshot),production:productionIdentity(moduleRoot),
  productSourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:moduleRoot,encoding:'utf8'}).trim(),failures:[]};
const config={moduleRoot,fixtureRoot,coordinationSnapshot:snapshot,parentHash:option('--parent-hash'),output,bindings:true};
const file=path.join(output,'fixture.private.cjs'),result=path.join(output,'child.private.json');
const url=relative=>new URL(relative,import.meta.url).href;
fs.writeFileSync(file,`const{app,ipcMain}=require('electron');const fs=require('node:fs'),inspector=require('node:inspector');app.setPath('userData',${JSON.stringify(path.join(output,'user-data'))});
process.env.PEER_AGENT_HOME=${JSON.stringify(fixtureRoot)};process.env.PEER_AGENT_SLOW_TIMER_MS='0';
app.whenReady().then(async()=>{const config=${JSON.stringify(config)};
const{createReadHost}=await import(${JSON.stringify(url('./ri00/read-host.mjs'))});const{createTrace}=await import(${JSON.stringify(url('./ri00/trace.mjs'))});
const{guardReadOnlySource}=await import(${JSON.stringify(url('./ri00/readonly-coordination.mjs'))});
const{controlledSessionRead}=await import(${JSON.stringify(url('./ri00/paired-read-cpu.mjs'))});const{readMicroprobe}=await import(${JSON.stringify(url('./ri00/read-microprobe.mjs'))});
const guard=guardReadOnlySource(config.fixtureRoot);let host;const data={phases:[],failures:[]};
try{host=await createReadHost({...config,readOnlyGuard:guard,trace:createTrace({enabled:false})});
function bind(callback){return function(event,payload){return callback(payload);}}function callback(ports){return payload=>ports.listObligationGrants(payload);}
ipcMain.handle('project-agent:list-obligation-grants',bind(callback({listObligationGrants:host.service.listObligationGrants})));
for(let i=0;i<6;i++)host.sessionFacts();
async function phase(name){const reads=await controlledSessionRead.call(host.readPorts.supervisor,host.readPorts.goalPlanStore,host.payload,{rounds:7,delayMs:150});
const micro=readMicroprobe.call(host.readPorts.goalPlanStore);data.phases.push({name,reads,micro});fs.writeSync(1,JSON.stringify({stage:name,ok:reads.ok})+'\\n');if(!reads.ok)throw Error('invalid_phase');}
const gate=marker=>new Promise(resolve=>{globalThis.__ri00LateGate=resolve;fs.writeSync(1,marker+'\\n');});
await phase('before-agent');inspector.open(0,'127.0.0.1');await gate('ri00-late-open');await phase('after-agent');
await gate('ri00-late-scopes');await phase('after-scopes');fs.writeSync(1,'ri00-late-close\\n');await new Promise(resolve=>setTimeout(resolve,250));inspector.close();await phase('after-close');
data.ok=host.readFailures()===0&&data.phases.every(phase=>phase.reads.ok);data.readFailures=host.readFailures();
}catch(error){data.ok=false;data.failures.push({name:error.name,message:error.message});}
finally{delete globalThis.__ri00LateGate;host?.close();data.guard={...guard.state};guard.close();fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(data,null,2),{mode:0o600});app.exit(data.ok?0:1);}
}).catch(error=>{fs.writeFileSync(${JSON.stringify(path.join(output,'error.private.txt'))},error.stack);app.exit(1);});`,{mode:0o600});
try{new vm.Script(fs.readFileSync(file,'utf8'),{filename:'ri00-late-inspector-fixture.cjs'});}
catch(error){report.failures.push({name:error.name,message:'generated_fixture_syntax_error'});report.ok=false;fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report,null,2),{mode:0o600});throw new Error('generated_fixture_syntax_error');}
let socket,port,sequence=0;const pending=new Map();
async function connect(endpoint){socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  socket.onmessage=event=>{const reply=JSON.parse(event.data),entry=pending.get(reply.id);if(!entry)return;pending.delete(reply.id);clearTimeout(entry.timer);reply.error?entry.reject(new Error('inspector_reply_failed')):entry.resolve(reply.result);};
  socket.onclose=()=>{for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('owned_inspector_disconnected'));}pending.clear();};}
function post(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('inspector_stage_timeout'));},10000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
const require=createRequire(path.join(moduleRoot,'apps/desktop/package.json')),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[file],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',bridge=Promise.resolve();
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
child.stderr.on('data',bytes=>{stderr+=bytes;});
createInterface({input:child.stdout}).on('line',line=>{stdout+=line+'\n';if(!line.startsWith('ri00-late-'))return;
  bridge=bridge.then(async()=>{
    if(line==='ri00-late-open'){
      let match;for(let i=0;i<100&&!(match=stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+/));i++)await wait(20);
      if(!match)throw new Error('owned_inspector_not_ready');port=Number(match[1]);await connect(match[0]);
      const identity=await post('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(identity.result.value!==child.pid)throw new Error('owned_inspector_pid_mismatch');
    }else if(line==='ri00-late-scopes'){
      const refs=await readPortReferences(post);report.readModules=refs.map(ref=>ref.module);report.discovery=refs.discovery;await post('Runtime.releaseObjectGroup',{objectGroup:'ri00-read-ports'});
    }else if(line==='ri00-late-close'){socket.close();return;}
    const reply=await post('Runtime.evaluate',{expression:'globalThis.__ri00LateGate();true',returnByValue:true});if(reply.exceptionDetails)throw new Error('owned_phase_gate_failed');
  }).catch(error=>{report.failures.push({name:error.name,message:error.message});child.kill('SIGTERM');});
});
let hardKill;const watchdog=setTimeout(()=>{report.timedOut=true;child.kill('SIGTERM');hardKill=setTimeout(()=>child.kill('SIGKILL'),1500);},120000);
const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(watchdog);clearTimeout(hardKill);await bridge;socket?.close();report.childExit={code:child.exitCode,signal:child.signalCode};
fs.writeFileSync(path.join(output,'stdout.private.txt'),stdout,{mode:0o600});fs.writeFileSync(path.join(output,'stderr.private.txt'),stderr,{mode:0o600});
report.child=fs.existsSync(result)?JSON.parse(fs.readFileSync(result,'utf8')):null;
report.harnessUnchanged=JSON.stringify(report.harness)===JSON.stringify(harness());report.fixtureUnchanged=JSON.stringify(report.fixture)===JSON.stringify(fixtureIdentity(fixtureRoot));
report.snapshotUnchanged=JSON.stringify(report.snapshot)===JSON.stringify(contentIdentity(snapshot));report.productionUnchanged=JSON.stringify(report.production)===JSON.stringify(productionIdentity(moduleRoot));
report.closeCheck=port?await inspectClosure(port):null;
report.ok=code===0&&report.child?.ok&&report.child.guard.sourceWritesDenied===0&&!report.failures.length&&report.harnessUnchanged&&report.fixtureUnchanged&&report.snapshotUnchanged&&report.productionUnchanged&&report.closeCheck?.closed;
report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({ok:report.ok,phases:report.child?.phases.map(phase=>({name:phase.name,readUserMs:phase.reads.reads.map(row=>row.userMs),evidenceUserMs:phase.reads.reads.map(row=>row.evidence.reduce((sum,span)=>sum+span.userMs,0))})),failures:report.failures}));if(!report.ok)process.exitCode=1;
