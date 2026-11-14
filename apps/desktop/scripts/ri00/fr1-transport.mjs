/** Fixed passive operations only. No read/request/native/expression interface is exposed by the returned recorder adapter. */
export async function connectFr1Transport(url,{pid,onNotice=()=>{},timeoutMs=2000}={}){
 const ws=new WebSocket(url),pending=new Map();let seq=0,closed=false,recorderId;const wire={},notices=[];
 await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('fr1_connect_timeout')),timeoutMs);ws.addEventListener('open',()=>{clearTimeout(t);resolve();},{once:true});ws.addEventListener('error',e=>{clearTimeout(t);reject(e);},{once:true});});
 ws.addEventListener('message',event=>{try{const x=JSON.parse(String(event.data));if(x.method==='Runtime.bindingCalled'&&x.params.name==='__ri00_fr1_notice'){const value=JSON.parse(x.params.payload);onNotice(value);return;}
  const p=pending.get(x.id);if(!p)return;pending.delete(x.id);clearTimeout(p.timer);x.error?p.reject(Error(x.error.message)):p.resolve(x.result);
 }catch(e){for(const p of pending.values())p.reject(e);pending.clear();}});
 ws.addEventListener('close',()=>{closed=true;for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('fr1_transport_closed'));}pending.clear();});
 function post(method,params={}){if(closed)return Promise.reject(Error('fr1_transport_closed'));wire[method]=(wire[method]||0)+1;
  return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('fr1_rpc_outcome_unknown:'+method));},timeoutMs);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});}
 const p=await post('Runtime.evaluate',{expression:'process.pid',returnByValue:true});if(p.result.value!==pid){ws.close();throw Error('fr1_pid_mismatch');}
 const evaluate=async expression=>{const r=await post('Runtime.evaluate',{expression,returnByValue:true});if(r.exceptionDetails)throw Error('fr1_eval:'+String(r.exceptionDetails.exception?.description||r.exceptionDetails.text).slice(0,500));return r.result?.value;};
 const call=async(method,args={})=>{
  if(!['take','ack','state','renew','setEpoch','armProfile','stopProfile','takeProfile','ackProfile','stop'].includes(method))throw Error('fr1_operation_forbidden');
  if(!recorderId)throw Error('fr1_recorder_not_bound');
  const r=await post('Runtime.callFunctionOn',{objectId:recorderId,arguments:[{value:method},{value:args}],functionDeclaration:`function(method,args){const r=this;
   if(method==='take'){if(!r.__pendingTake){const s=r.__pendingTake={pending:true};s.promise=r.take();s.promise.then(value=>{s.value=value;s.pending=false;},error=>{s.error=String(error.message);s.pending=false;});}const s=r.__pendingTake;if(s.error)throw Error(s.error);return s.pending?{takePending:true}:{takePending:false,batch:s.value};}
   if(method==='ack'){const value=r.ack(args);if(r.__pendingTake?.value?.throughSeq===args.throughSeq)delete r.__pendingTake;return value;}
   if(method==='stop')return r.stop(args.reason);return r[method](args);
  }`,returnByValue:true});
  if(r.exceptionDetails)throw Error('fr1_remote:'+String(r.exceptionDetails.exception?.description||r.exceptionDetails.text).slice(0,500));return r.result?.value;
 };
 return {post,evaluate,call,wire,get recorderId(){return recorderId;},async bind(){if(recorderId)throw Error('fr1_recorder_already_bound');const x=await post('Runtime.evaluate',{expression:'globalThis.__ri00Fr1',objectGroup:'ri00-fr1'});if(!x.result?.objectId)throw Error('fr1_site_missing');recorderId=x.result.objectId;return true;},async take(){const end=performance.now()+timeoutMs;let value=await call('take');while(value.takePending){if(performance.now()>=end)throw Error('fr1_take_outcome_unknown');await new Promise(r=>setTimeout(r,5));value=await call('take');}return value.batch;},
  async close(){if(closed)return;ws.close();await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('fr1_transport_close_unknown')),2000);if(closed){clearTimeout(t);resolve();return;}ws.addEventListener('close',()=>{clearTimeout(t);resolve();},{once:true});});}};
}
