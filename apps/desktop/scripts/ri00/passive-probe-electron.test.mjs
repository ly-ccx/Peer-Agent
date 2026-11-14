import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import os from'node:os';import path from'node:path';import{spawn}from'node:child_process';import{createRequire}from'node:module';
import{createDenseResidualProbe}from'./dense-residual-probe.mjs';
test('serialized probe in real Electron calls no V8 statistics getter during natural observation or stream lifecycle',{timeout:20000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-passive-electron-')),ready=path.join(root,'ready'),file=path.join(root,'main.cjs');fs.writeFileSync(path.join(root,'evidence-index.jsonl'),'{}\n');
 fs.writeFileSync(file,`const{app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(root,'user-data'))});app.whenReady().then(()=>{
 const v8=require('node:v8');globalThis.calls={};for(const name of ['getHeapStatistics','getHeapSpaceStatistics','getHeapCodeStatistics']){calls[name]=0;const original=v8[name];v8[name]=function(...args){calls[name]++;return Reflect.apply(original,this,args)}}
 globalThis.value=[{}];globalThis.store={getStoreDir:()=>${JSON.stringify(root)},listEvidenceIndex:()=>[{}]};globalThis.host={list(){for(let i=0;i<12;i++)store.listEvidenceIndex();return value}};globalThis.originalList=host.list;globalThis.originalIndex=store.listEvidenceIndex;
 require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>app.exit(0),18000).unref();});`);
 const require=createRequire(import.meta.url),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(require('electron'),['--inspect=0',file],{env,stdio:['ignore','ignore','pipe']});let stderr='',ws,probe,passed=false;child.stderr.on('data',b=>stderr+=b);const wait=ms=>new Promise(r=>setTimeout(r,ms));
 let sequence=0,notices=0;const pending=new Map();
 const post=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('owned_inspector_timeout:'+method))},3000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const value=r=>{assert.equal(r.exceptionDetails,undefined);return r.result.value;};
 const evaluate=async expression=>value(await post('Runtime.evaluate',{expression,returnByValue:true}));
 const invoke=async(method,args=[])=>value(await post('Runtime.callFunctionOn',{objectId:probe,functionDeclaration:'function(method,args){return this[method](...args)}',arguments:[{value:method},{value:args}],returnByValue:true,awaitPromise:method==='take'}));
 try{
  for(let i=0;i<150&&(!fs.existsSync(ready)||!stderr.match(/ws:\/\/127\.0\.0\.1:\d+\//));i++)await wait(30);assert.ok(fs.existsSync(ready));
  const url=stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0];assert.ok(url);ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  ws.onmessage=e=>{const x=JSON.parse(e.data);if(x.method==='Runtime.bindingCalled')notices++;const p=pending.get(x.id);if(!p)return;clearTimeout(p.timer);pending.delete(x.id);x.error?p.reject(Error(x.error.message)):p.resolve(x.result);};
  await post('Runtime.enable');await post('Runtime.addBinding',{name:'__ri00_owned_passive_notice'});
  const storeId=(await post('Runtime.evaluate',{expression:'globalThis.store'})).result.objectId,hostId=(await post('Runtime.evaluate',{expression:'globalThis.host'})).result.objectId;
  const installed=await post('Runtime.callFunctionOn',{objectId:storeId,functionDeclaration:createDenseResidualProbe.toString(),arguments:[{objectId:hostId},{value:{workspaceId:'fixture'}},{value:{longWatch:true,durationMs:12000,notificationName:'__ri00_owned_passive_notice'}}]});assert.equal(installed.exceptionDetails,undefined);probe=installed.result.objectId;assert.ok(probe);
  assert.equal(await evaluate('host.list({workspaceId:"fixture"})===value'),true);await evaluate('store.listEvidenceIndex();true');await invoke('renew');assert.equal((await invoke('vm')).sample,null);
  const natural=await invoke('take');await invoke('ack');assert.equal(natural.rows.length,2);assert.equal(natural.heap,null);assert.equal(natural.rows[0].samplingSchema,'passive-cpu-v2');assert.equal(natural.rows[0].heapBefore,null);assert.equal(natural.rows[0].evidence.length,12);assert.equal(natural.rows[0].evidence[0].newSpaceBefore,undefined);
  assert.deepEqual(Object.values(await evaluate('({...calls})')),[0,0,0]);assert.ok(notices>0);
  const controlled=await invoke('read',['controlled-contract']);assert.equal(controlled.evidence.length,12);assert.ok(controlled.heapBefore.spaces.length>0);const activeCalls=await evaluate('({...calls})');assert.ok(activeCalls.getHeapStatistics>0&&activeCalls.getHeapSpaceStatistics>0);assert.equal(activeCalls.getHeapCodeStatistics,0);
  assert.equal((await invoke('vm')).notCurrentHeap,true);await invoke('take');await invoke('ack');await invoke('renew');assert.equal((await invoke('stop')).restored,true);assert.deepEqual(await evaluate('({...calls})'),activeCalls);
  assert.equal(await evaluate('host.list===originalList&&store.listEvidenceIndex===originalIndex&&!Object.hasOwn(globalThis,"__ri00_owned_passive_notice")'),true);assert.equal(child.exitCode,null);passed=true;
 }finally{
  if(ws?.readyState===1&&probe)try{await invoke('stop')}catch{}for(const p of pending.values())clearTimeout(p.timer);ws?.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode==null&&child.signalCode==null?child.once('close',r):r());
  if(passed)fs.rmSync(root,{recursive:true,force:true});else{fs.writeFileSync(path.join(root,'stderr.private.txt'),stderr);process.stderr.write('Failed owned passive fixture retained: '+root+'\n');}
 }
});
