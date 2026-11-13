import test from'node:test';import assert from'node:assert/strict';import inspector from'node:inspector';import{connectE3Transport}from'./e3-cdp-transport.mjs';
test('real CDP plain calls and strongly retained take polling round-trip until ACK, then close before host inspector',async()=>{
 let takes=0,acks=0;globalThis.__e3Owned={probe:{take(){takes++;return new Promise(r=>setImmediate(()=>r({rows:[{fixture:true}]})));},ack(){acks++;return true;},queueContext:()=>({stopped:false})},queue:{status:id=>({id,state:'completed'})}};
 inspector.open(0,'127.0.0.1');let transport;
 try{transport=await connectE3Transport(inspector.url(),{pid:process.pid});assert.equal((await transport.rpc('status',{id:1})).state,'completed');const first=await transport.rpc('take');assert.equal(first.rows.length,1);assert.deepEqual(await transport.rpc('take'),first);assert.equal(takes,1);await transport.rpc('ackBatch');assert.equal(acks,1);await transport.rpc('take');assert.equal(takes,2);await transport.rpc('ackBatch');}
 finally{await transport?.close();inspector.close();delete globalThis.__e3Owned;}
});
