/** Synthetic scale acceptance with the real stores; Electron/ASAR worker and event-loop measurement. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createPackage } from '@electron/asar';
import { _electron } from 'playwright-core';
import { createWorkCoordinationStore } from '../../../packages/runtime-node/dist/project-agent/work-coordination-store.mjs';
import { createConversationStore } from '@peer-agent/conversation-store';
const outputIndex=process.argv.indexOf('--output'), output=outputIndex<0?null:process.argv[outputIndex+1];
const source=fileURLToPath(new URL('../../..',import.meta.url)), root=mkdtempSync(path.join(tmpdir(),'peer-storage-perf-'));
const stats=values=>{const sorted=[...values].sort((a,b)=>a-b);return {n:sorted.length,p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))],max:sorted.at(-1)};};
const report={schemaVersion:1,scope:'Synthetic 75MB journal / 46MB history, production stores; Electron main loop and worker inside an ASAR package, not a real model task.',cases:{}};
let app;
try{
 const runtime=path.join(root,'runtime'),dir=path.join(runtime,'large');mkdirSync(dir,{recursive:true});
 const journal=path.join(dir,'coordination.jsonl');let revision=0;
 for(let block=0;block<50;block++)appendFileSync(journal,Array.from({length:100},()=>JSON.stringify({schemaVersion:1,revision:++revision,kind:'work',work:{workId:'w'+revision%32,state:'cancelled',brief:'historical evidence '.repeat(750)}})).join('\n')+'\n');
 report.journalBytes=statSync(journal).size;let bytes=0;
 const store=createWorkCoordinationStore({rootDir:runtime,workspaceId:'large',onJournalRead:event=>bytes+=event.bytes});
 const cold=performance.now();store.read();report.coldReadMs=performance.now()-cold;
 const hot=[],tail=[];bytes=0;
 for(let i=0;i<30;i++){const at=performance.now();store.read();hot.push(performance.now()-at);}
 report.hotReadBytes=bytes;
 for(let i=0;i<30;i++){appendFileSync(journal,JSON.stringify({schemaVersion:1,revision:++revision,kind:'work',work:{workId:'small',state:'runnable',revision:i}})+'\n');const at=performance.now();store.read();tail.push(performance.now()-at);}
 report.cases.hot=stats(hot);report.cases.tail=stats(tail);report.tailReadBytes=bytes;
 const conversations=path.join(root,'conversations'),cs=createConversationStore({storeDir:conversations}),meta=cs.createConversation({title:'large fixture'});
 cs.replaceMessages(meta.id,Array.from({length:315},(_,i)=>({id:'old-'+i,role:i%2?'assistant':'user',content:'history data '.repeat(11400)})).concat({id:'answer',role:'assistant',content:''}));
 report.historyBytes=statSync(path.join(conversations,meta.id+'.jsonl')).size;
 const pack=path.join(root,'pack');mkdirSync(pack);
 for(const name of ['conversation-store','protocol']){const dest=path.join(pack,'node_modules/@peer-agent',name);mkdirSync(dest,{recursive:true});cpSync(path.join(source,'packages',name,'dist'),path.join(dest,'dist'),{recursive:true});cpSync(path.join(source,'packages',name,'package.json'),path.join(dest,'package.json'));}
 writeFileSync(path.join(pack,'package.json'),JSON.stringify({type:'module',main:'main.mjs'}));
 writeFileSync(path.join(pack,'main.mjs'),"import {app} from 'electron'; import * as hooks from 'node:perf_hooks'; globalThis.perfHooks=hooks; import {createConversationStore} from '@peer-agent/conversation-store'; globalThis.perfStore=createConversationStore; app.whenReady().then(()=>{});");
 const archive=path.join(root,'perf.asar');await createPackage(pack,archive);
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 app=await _electron.launch({args:[archive,'--user-data-dir='+path.join(root,'chromium')],env,timeout:30000});
 report.electron=await app.evaluate(async({},{conversations,id})=>{
   const {monitorEventLoopDelay,performance}=globalThis.perfHooks;
   const store=globalThis.perfStore({storeDir:conversations}),samples=[],sync=[],gaps=[];
   let last=performance.now();const timer=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;},1);
   const histogram=monitorEventLoopDelay({resolution:1});histogram.enable();
   await new Promise(resolve=>setTimeout(resolve,30));
   for(let i=0;i<5;i++){store.patchStreamingMessage(id,'answer',{content:'partial'});const at=performance.now();const pending=store.commitStreamingMessage(id,'answer',{content:'done '+i});sync.push(performance.now()-at);await pending;samples.push(performance.now()-at);await new Promise(resolve=>setTimeout(resolve,10));}
   clearInterval(timer);histogram.disable();
   return {node:process.versions.node,electron:process.versions.electron,workerTotalMs:samples,enqueueMs:sync,eventLoopGapsMs:gaps,eventLoopMaxMs:histogram.max/1e6,final:store.getConversation(id).messages.at(-1).content};
 },{conversations,id:meta.id});
 report.cases.terminalTotal=stats(report.electron.workerTotalMs);report.cases.mainEnqueue=stats(report.electron.enqueueMs);report.cases.mainLoop=stats(report.electron.eventLoopGapsMs);
 delete report.electron.eventLoopGapsMs;
 report.ok=report.journalBytes>=75e6&&report.historyBytes>=46e6&&report.hotReadBytes===0&&report.cases.hot.p95<10&&report.cases.tail.p95<25&&report.electron.eventLoopMaxMs<50&&report.electron.final==='done 4';
}catch(error){report.ok=false;report.error=error.stack;}finally{if(app)await app.close();rmSync(root,{recursive:true,force:true});if(output)writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;}
