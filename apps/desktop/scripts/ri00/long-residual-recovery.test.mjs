import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';
import{createRequire}from'node:module';import{spawn}from'node:child_process';import{inspectClosure}from'./trace.mjs';

test('real Electron restores the long probe and closes its inspector after controller death without quitting the host',{timeout:20000},async()=>{
 const require=createRequire(import.meta.url),moduleRoot=path.resolve(path.dirname(require.resolve('@peer-agent/runtime-node')),'../../..');
 const desktopRequire=createRequire(path.join(moduleRoot,'apps/desktop/package.json')),root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-long-recovery-'));
 const ready=path.join(root,'ready'),installed=path.join(root,'installed'),recovered=path.join(root,'recovered.private.json'),main=path.join(root,'main.cjs'),controller=path.join(root,'controller.mjs');
 fs.writeFileSync(path.join(root,'evidence-index.jsonl'),'{}\n');
 fs.writeFileSync(main,`const{app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'user-data'))});app.whenReady().then(async()=>{
 const{createDenseResidualProbe}=await import(${JSON.stringify(new URL('./dense-residual-probe.mjs',import.meta.url).href)});
 const data=[{}],value=[{}],store={getStoreDir:()=>${JSON.stringify(root)},listEvidenceIndex:()=>data},host={list(){for(let i=0;i<12;i++)store.listEvidenceIndex();return value;}};
 const originalIndex=store.listEvidenceIndex,originalList=host.list;globalThis.install=()=>{globalThis.probe=createDenseResidualProbe.call(store,host,{workspaceId:'fixture'},{longWatch:true,durationMs:15000,leaseMs:1000,notificationName:'__ri00_notice',closeInspectorOnWatchdog:true});return true};
 setInterval(()=>{const result=host.list({workspaceId:'fixture'});if(globalThis.probe&&host.list===originalList&&store.listEvidenceIndex===originalIndex){require('fs').writeFileSync(${JSON.stringify(recovered)},JSON.stringify({resultIdentity:result===value,methodsRestored:true,bindingRemoved:!Object.hasOwn(globalThis,'__ri00_notice'),state:globalThis.probe.stop()}));}},100);
 setTimeout(()=>app.exit(0),18000).unref();require('fs').writeFileSync(${JSON.stringify(ready)},'ready');});`);
 fs.writeFileSync(controller,`import fs from'node:fs';const list=await(await fetch(process.argv[2])).json(),ws=new WebSocket(list[0].webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);let seq=0;const pending=new Map();ws.onmessage=e=>{const x=JSON.parse(e.data),p=pending.get(x.id);if(p){pending.delete(x.id);x.error?p.reject(Error(x.error.message)):p.resolve(x.result)}};const post=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});await post('Runtime.addBinding',{name:'__ri00_notice'});const temporary=(await post('Runtime.evaluate',{expression:'globalThis.install',objectGroup:'temporary-discovery'})).result.objectId;const owned=(await post('Runtime.callFunctionOn',{objectId:temporary,objectGroup:'owned-port',functionDeclaration:'function(){return this;}'})).result.objectId;await post('Runtime.releaseObjectGroup',{objectGroup:'temporary-discovery'});const result=await post('Runtime.callFunctionOn',{objectId:owned,functionDeclaration:'function(){return this();}',returnByValue:true});if(result.exceptionDetails||result.result.value!==true)throw Error('install_failed');fs.writeFileSync(process.argv[3],'installed');setInterval(()=>{},1000);`);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(desktopRequire('electron'),['--inspect=0',main],{env,stdio:['ignore','ignore','pipe']});let stderr='',worker,passed=false;
 child.stderr.on('data',b=>stderr+=b);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  for(let i=0;i<150&&(!fs.existsSync(ready)||!stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\//));i++)await wait(50);
  const port=Number(stderr.match(/ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]);assert.ok(port&&fs.existsSync(ready));
  worker=spawn(process.execPath,[controller,`http://127.0.0.1:${port}/json/list`,installed],{stdio:'ignore'});
  for(let i=0;i<100&&!fs.existsSync(installed);i++)await wait(50);assert.ok(fs.existsSync(installed));worker.kill('SIGKILL');await new Promise(r=>worker.once('close',r));
  for(let i=0;i<100&&!fs.existsSync(recovered);i++)await wait(50);assert.ok(fs.existsSync(recovered));const receipt=JSON.parse(fs.readFileSync(recovered));
  assert.equal(receipt.resultIdentity,true);assert.equal(receipt.methodsRestored,true);assert.equal(receipt.bindingRemoved,true);assert.equal(receipt.state.restored,true);assert.match(receipt.state.stopReason,/controller-lease|notification-failure/);
  for(let i=0;i<120;i++){const closure=await inspectClosure(port,{required:false});if(closure.closed)break;await wait(50);}
  const closure=await inspectClosure(port,{required:true});assert.equal(closure.closed,true);assert.equal(child.exitCode,null);passed=true;
 }finally{
  if(worker&&worker.exitCode==null&&worker.signalCode==null)worker.kill('SIGKILL');child.kill('SIGTERM');await new Promise(r=>child.exitCode==null&&child.signalCode==null?child.once('close',r):r());
  if(passed)fs.rmSync(root,{recursive:true,force:true});else{fs.writeFileSync(path.join(root,'stderr.private.txt'),stderr);process.stderr.write('Failed owned recovery fixture retained: '+root+'\n');}
 }
});
