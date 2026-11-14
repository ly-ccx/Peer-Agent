import {fr1InstallDeclaration}from'./fr1-install.mjs';
export const FR1_NOTICE='__ri00_fr1_notice';
export async function installFr1Session(transport,refs,options){
 await transport.post('Runtime.enable');await transport.post('Runtime.addBinding',{name:FR1_NOTICE});
 const r=await transport.post('Runtime.callFunctionOn',{objectId:refs.store,functionDeclaration:fr1InstallDeclaration(),arguments:[{objectId:refs.supervisor},{objectId:refs.ports},{objectId:refs.directory},{value:{...options,notificationName:FR1_NOTICE}}],returnByValue:true});
 if(r.exceptionDetails)throw Error('fr1_install:'+String(r.exceptionDetails.exception?.description||r.exceptionDetails.text));await transport.bind();
 if(r.result.value.ownerId!==options.ownerId)throw Error('fr1_install_owner_mismatch');return r.result.value;
}
export async function archiveFr1Batch(transport,journal){
 const batch=journal.pending||await transport.take();const receipt=journal.commit(batch);await transport.call('ack',{throughSeq:batch.throughSeq});return{batch,receipt};
}
export async function stopFr1Session(transport,journal,{ownerId}={}){
 const initial=await transport.call('state');if(initial.ownerId!==ownerId)throw Error('fr1_cleanup_owner_mismatch');
 await transport.call('stop',{reason:'controller'});const deadline=performance.now()+10000;
 let state=await transport.call('state');while(state.profiler.phase==='stopping'&&performance.now()<deadline){await new Promise(r=>setTimeout(r,20));state=await transport.call('state');}
 for(let i=0;i<20;i++){await archiveFr1Batch(transport,journal);state=await transport.call('state');if(!state.retainedBytes&&!state.inFlightEntries)break;await new Promise(r=>setTimeout(r,50));}
 const restored=state.restored===true&&state.ownersRestored===true&&state.bindingRestored===true&&!state.retainedBytes&&!state.inFlightEntries&&!state.lost&&!state.metadataErrors&&state.profiler.phase!=='stopping'&&(!state.profiler.startAttempts||state.profiler.disabled===true);
 return{restored,state,initial};
}
