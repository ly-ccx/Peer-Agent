/** Fixed metadata/read-probe operations. Never invokes a product IPC or arbitrary remote expression. */
export async function connectE3Transport(url,{pid,timeoutMs=2000}={}){
 const ws=new WebSocket(url),pending=new Map();let seq=0,closed=false;
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('e3_cdp_connect_timeout'));},timeoutMs);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',e=>{clearTimeout(timer);reject(e);},{once:true});});
 const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 ws.addEventListener('close',()=>{closed=true;fail(Error('e3_cdp_disconnected'));});
 ws.addEventListener('message',e=>{try{if(String(e.data).length>16777216)throw Error('e3_cdp_response_cap');const v=JSON.parse(String(e.data)),p=pending.get(v.id);if(!p)return;pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}catch(error){fail(error);}});
 function post(method,params={}){if(closed)return Promise.reject(Error('e3_cdp_closed'));return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('e3_cdp_rpc_timeout'));},timeoutMs);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
 const identity=await post('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(identity.result?.value!==pid){ws.close();throw Error('e3_cdp_pid_mismatch');}
 const result=await post('Runtime.evaluate',{expression:'globalThis.__e3Owned',objectGroup:'ri00-e3-controller'});if(!result.result?.objectId){ws.close();throw Error('e3_cdp_site_missing');}const objectId=result.result.objectId;
 return{post,
  async rpc(method,args={}){const reply=await post('Runtime.callFunctionOn',{objectId,arguments:[{value:method},{value:args}],returnByValue:true,awaitPromise:true,functionDeclaration:`function(method,args){
   if(method==='request')return this.queue.request(args);
   if(method==='status')return this.queue.status(args.id);
   if(method==='ackTicket')return this.queue.ack(args.id);
   if(method==='take')return this.probe.take();
   if(method==='ackBatch')return this.probe.ack();
   if(method==='takeEntries')return this.entries.take();
   if(method==='ackEntries')return this.entries.ack();
   if(method==='renew')return this.renew();
   if(method==='stop')return this.probe.stop(args.reason||'controller');
   if(method==='statusProbe')return this.probe.queueContext();
   if(method==='native')return this.probe.native();
   throw Error('e3_cdp_operation_not_allowed');
  }`});if(reply.exceptionDetails)throw Error('e3_cdp_remote_exception:'+String(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text).slice(0,512));return reply.result?.value;},
  async close(){try{await post('Runtime.releaseObjectGroup',{objectGroup:'ri00-e3-controller'});}finally{ws.close();}}
 };
}
