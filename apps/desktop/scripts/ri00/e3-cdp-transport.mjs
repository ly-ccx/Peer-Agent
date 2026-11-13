/** Fixed metadata/read-probe operations. Never invokes a product IPC or arbitrary remote expression. */
export async function connectE3Transport(url,{pid,timeoutMs=2000,onCommand=()=>{}}={}){
 const ws=new WebSocket(url),pending=new Map();let seq=0,closed=false,closedResolve;const closedPromise=new Promise(r=>{closedResolve=r;});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('e3_cdp_connect_timeout'));},timeoutMs);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',e=>{clearTimeout(timer);reject(e);},{once:true});});
 const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();};
 ws.addEventListener('close',()=>{closed=true;fail(Error('e3_cdp_disconnected'));closedResolve();});
 ws.addEventListener('message',e=>{try{if(String(e.data).length>16777216)throw Error('e3_cdp_response_cap');const v=JSON.parse(String(e.data)),p=pending.get(v.id);if(!p)return;pending.delete(v.id);clearTimeout(p.timer);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}catch(error){fail(error);}});
 function post(method,params={}){if(closed)return Promise.reject(Error('e3_cdp_closed'));return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('e3_cdp_rpc_timeout'));},timeoutMs);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
 const identity=await post('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(identity.result?.value!==pid){ws.close();throw Error('e3_cdp_pid_mismatch');}
 const result=await post('Runtime.evaluate',{expression:'globalThis.__e3Owned',objectGroup:'ri00-e3-controller'});if(!result.result?.objectId){ws.close();throw Error('e3_cdp_site_missing');}const objectId=result.result.objectId;
 const declaration=`function(method,args,legacy){
   if(method==='request')return this.queue.request(args);
   if(method==='status')return this.queue.status(args.id);
   if(method==='ackTicket')return this.queue.ack(args.id);
   if(method==='take'){
    if(legacy)return this.probe.take();
    if(!this.__ri00ControllerTake){const slot={pending:true};this.__ri00ControllerTake=slot;slot.promise=this.probe.take();slot.promise.then(value=>{slot.value=value;slot.pending=false;},error=>{slot.error={name:error.name,message:error.message};slot.pending=false;});}
    const slot=this.__ri00ControllerTake;return slot.pending?{takePending:true}:slot.error?{takeError:slot.error}:{takePending:false,value:slot.value};
   }
   if(method==='ackBatch'){const value=this.probe.ack();delete this.__ri00ControllerTake;return value;}
   if(method==='takeEntries')return this.entries.take();
   if(method==='ackEntries')return this.entries.ack();
   if(method==='renew')return this.renew();
   if(method==='stop')return this.probe.stop(args.reason||'controller');
   if(method==='statusProbe')return this.probe.queueContext();
   if(method==='native')return this.probe.native();
   throw Error('e3_cdp_operation_not_allowed');
  }`;
 async function invoke(method,args,legacy){onCommand({operation:method,legacy,atMs:performance.now()});try{const reply=await post('Runtime.callFunctionOn',{objectId,arguments:[{value:method},{value:args},{value:legacy}],returnByValue:true,awaitPromise:legacy,functionDeclaration:declaration});if(reply.exceptionDetails)throw Error('remote_exception:'+String(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text).slice(0,512));return reply.result?.value;}catch(error){onCommand({operation:method,legacy,error:error.message,atMs:performance.now()});throw Error('e3_cdp_operation_'+method+':'+error.message,{cause:error});}}
 return{post,
  legacyRpc:(method,args={})=>invoke(method,args,true),
  async rpc(method,args={}){let value=await invoke(method,args,false);if(method!=='take')return value;const end=performance.now()+timeoutMs;while(value.takePending){if(performance.now()>=end)throw Error('e3_cdp_take_timeout');await new Promise(r=>setTimeout(r,2));value=await invoke(method,args,false);}if(value.takeError)throw Error('e3_cdp_take_failed:'+value.takeError.message);return value.value;},
  async close(){if(closed)return;try{await post('Runtime.releaseObjectGroup',{objectGroup:'ri00-e3-controller'});}finally{ws.close();let timer;try{await Promise.race([closedPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('e3_cdp_close_unverified')),timeoutMs);})]);}finally{clearTimeout(timer);}}}
 };
}
