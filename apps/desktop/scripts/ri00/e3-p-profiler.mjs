/** Exactly one start attempt, no read replay, and unconditional bounded stop/disable reconciliation. */
export async function capturePProfile({post,readBlock,save,measure=async()=>null,now=()=>performance.now()}){
 const result={startAttempted:false,started:false,stopAttempted:false,stopped:false,disabled:false,complete:false,commands:[],errors:[],rows:[],costPoints:{}};let profile,primary;
 const record=(phase,error)=>{result.errors.push({phase,name:error.name||'Error',message:String(error.message)});primary??=error;};
 const call=async(method,params={})=>{result.commands.push(method);return post(method,params);};
 async function point(name){try{result.costPoints[name]=await measure(name);}catch(e){record('measure-'+name,e);}}
 await point('setupBefore');
 try{
  if(primary)throw primary;await call('Profiler.enable');await call('Profiler.setSamplingInterval',{interval:1000});result.startAttempted=true;result.sessionStartMs=now();await call('Profiler.start');result.started=true;
  await point('setupAfter');if(primary)throw primary;const block=await readBlock();result.rows=block.points||block.rows||[];result.block=block;result.bodyComplete=true;
 }catch(error){record('setup-or-body',error);}
 finally{
  if(!result.costPoints.setupAfter)await point('setupAfter');await point('stopBefore');
  if(result.startAttempted){result.stopAttempted=true;try{const response=await call('Profiler.stop');profile=response.profile;result.stopped=Boolean(profile);if(!profile)throw Error('p_profile_stop_missing');}catch(error){record('stop',error);}}
  try{await call('Profiler.disable');result.disabled=true;}catch(error){record('disable',error);}result.sessionEndMs=now();await point('stopAfter');
  result.profileReturned=Boolean(profile);result.complete=Boolean(result.bodyComplete&&result.stopped&&result.disabled&&!result.errors.length);
  if(profile)try{await save({profile,result});result.saved=true;}catch(error){record('save',error);result.complete=false;}
 }
 result.error=primary?{name:primary.name,message:String(primary.message)}:null;result.recoveryKnown=result.disabled;result.noReplay=true;return result;
}
