/** Own one inspector profile. Preserve partial data and the original read error on abnormal exit. */
export async function captureCpuProfile({post,read,onRead=()=>{},save,onCleanupError=()=>{}},count=3){
  if(!Number.isInteger(count)||count<1||count>3)throw Error('bounded_profile_read_count_required');
  let startAttempted=false,profile,bodyError,complete=false;const rows=[];
  try{
    await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:500});startAttempted=true;await post('Profiler.start');
    for(let i=0;i<count;i++){const row=await read();rows.push(row);await onRead(row);}complete=true;
  }catch(error){bodyError=error;throw error;}
  finally{
    let cleanupError;
    if(startAttempted)try{profile=(await post('Profiler.stop')).profile;}catch(error){cleanupError=error;onCleanupError('stop',error);}
    try{await post('Profiler.disable');}catch(error){cleanupError??=error;onCleanupError('disable',error);}
    if(profile)try{await save({profile,rows,complete:complete&&!cleanupError});}catch(error){cleanupError??=error;onCleanupError('save',error);}
    if(cleanupError&&!bodyError)throw cleanupError;
  }
}
