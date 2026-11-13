import test from'node:test';import assert from'node:assert/strict';import inspector from'node:inspector';import{connectE3Transport}from'./e3-cdp-transport.mjs';
import fs from'node:fs';import os from'node:os';import path from'node:path';import{createDenseResidualProbe}from'./dense-residual-probe.mjs';import{createReadTicketQueue}from'./read-ticket-queue.mjs';
test('real CDP plain calls and strongly retained take polling round-trip until ACK, then close before host inspector',async()=>{
 let takes=0,acks=0;globalThis.__e3Owned={probe:{take(){takes++;return new Promise(r=>setImmediate(()=>r({rows:[{fixture:true}]})));},ack(){acks++;return true;},queueContext:()=>({stopped:false})},queue:{status:id=>({id,state:'completed'})}};
 inspector.open(0,'127.0.0.1');let transport;
 try{transport=await connectE3Transport(inspector.url(),{pid:process.pid});assert.equal((await transport.rpc('status',{id:1})).state,'completed');const first=await transport.rpc('take');assert.equal(first.rows.length,1);assert.deepEqual(await transport.rpc('take'),first);assert.equal(takes,1);await transport.rpc('ackBatch');assert.equal(acks,1);await transport.rpc('take');assert.equal(takes,2);await transport.rpc('ackBatch');}
 finally{await transport?.close();inspector.close();delete globalThis.__e3Owned;}
});
test('real queue completion binding replaces status polling and is removed with its owner',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ri00-binding-'));fs.writeFileSync(path.join(dir,'evidence-index.jsonl'),'{}\n');let reads=0;
 const store={getStoreDir:()=>dir,listEvidenceIndex:()=>[{}]},supervisor={list(){reads++;for(let i=0;i<12;i++)store.listEvidenceIndex();return[{}];}},probe=createDenseResidualProbe.call(store,supervisor,{workspaceId:'fixture'},{longWatch:true,eventLoopReads:true,ownedExperiment:true,durationMs:10000}),queue=createReadTicketQueue(probe,{owner:'notice-unit',epoch:'notice-unit'});
 globalThis.__e3Owned={probe,queue,renew:()=>probe.renew()};const commands=[];let transport;inspector.open(0,'127.0.0.1');
 try{transport=await connectE3Transport(inspector.url(),{pid:process.pid,onCommand:e=>commands.push(e)});await transport.rpc('request',{id:1,kind:'witness',label:'notification'});assert.equal((await transport.rpc('status',{id:1})).state,'completed');assert.equal(commands.filter(x=>x.operation==='status').length,1);const batch=await transport.rpc('take');assert.equal(batch.rows.length,1);await transport.rpc('ackBatch');await transport.rpc('ackTicket',{id:1});assert.equal(reads,1);assert.equal(probe.stop().restored,true);assert.equal(queue.snapshot().noticeFailures,0);}
 finally{await transport?.close();inspector.close();probe.stop();delete globalThis.__e3Owned;assert.equal(Object.getOwnPropertyNames(globalThis).filter(k=>k.startsWith('__ri00_controller_done_')).length,0);fs.rmSync(dir,{recursive:true,force:true});}
});
