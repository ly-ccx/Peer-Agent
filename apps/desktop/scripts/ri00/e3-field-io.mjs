import{evaluateE3Checkpoint}from'./e3-checkpoint.mjs';

/** Real read/confirmation adapter, independent of process launch or product actions. */
export function createE3FieldIO({target,reference,journal,identity,expected,checkpointIdentity,admit,cancelled=()=>false,collectHook=async()=>{},wait=ms=>new Promise(r=>setTimeout(r,ms)),durationBudgetMs=1800000}){
 let targetClock=target.readyMs,clockAt=performance.now(),checkpoints=0;
 const now=()=>targetClock+performance.now()-clockAt;
 const sync=record=>{targetClock=record.batch.clock.performanceMs;clockAt=performance.now();return record;};
 async function read(host,kind,label){if(!admit(kind==='dense'?'read':'witness-read'))throw Error('e3_io_read_budget');const p=await host.reader.read(kind,label);if(host===target)sync(p.record);return p;}
 const io={now,cancelled,admit,identity,notFieldCause:false,queueBusy:()=>target.reader.state().busy,
  append:(kind,value)=>journal.append(kind,value),
  expectedNaturalIdentity(cp){const row=cp.mainA.points[0].row;return JSON.stringify([row.sourceBefore,row.outputSha256,row.evidence.map(e=>e.rows)]);},
  async checkpoint(state,label){if(++checkpoints>6)throw Error('e3_io_checkpoint_cap');const before=await identity({force:true});
   async function block(host,suffix){const b={points:[],calibration:[]};for(let i=0;i<8;i++){b.points.push(await read(host,'dense',label+'-'+suffix+'-'+i));await wait(150);}
    for(let i=0;i<3;i++){if(!admit('native'))throw Error('e3_io_native_budget');const c=await host.transport.rpc('native');host.nativeCpuMs=(host.nativeCpuMs||0)+c.userMs+c.systemMs;b.calibration.push(c);journal.append('native-calibration',{host:host.label,result:c});}return b;}
   const mainA=await block(target,'main-a'),ref=await block(reference,'reference'),mainB=await block(target,'main-b'),after=await identity({force:true});
   return{mainA,reference:ref,mainB,...evaluateE3Checkpoint(state,{identity:checkpointIdentity,mainA,reference:ref,mainB,sourceStable:before.key===after.key&&before.stable&&after.stable,expected})};
  },
  async witnessSequence(label){const countsBefore=target.getters?await target.getters():null,refCounts=reference.getters?await reference.getters():null;
   const a=await read(target,'witness',label+'-main-first'),r=await read(reference,'witness',label+'-reference'),b=await read(target,'witness',label+'-main-second');
   if(countsBefore&&JSON.stringify(countsBefore)!==JSON.stringify(await target.getters())||refCounts&&JSON.stringify(refCounts)!==JSON.stringify(await reference.getters()))throw Error('e3_io_witness_heap_getter');
   return[a.row,r.row,b.row];
  },
  async collect(end){await wait(Math.max(1,Math.min(1000,end-now(),durationBudgetMs)));await target.transport.rpc('renew');await reference.transport.rpc('renew');await collectHook({nowMs:now()});const record=sync(await target.reader.drain());
   return{rows:record.batch.rows,entries:record.entries.entries,nowMs:record.batch.clock.performanceMs,sourceEpoch:(await identity()).epoch};},
  async stop(reason){const states=[];for(const host of[target,reference])try{const s=await host.transport.rpc('stop',{reason:'controller'});states.push({label:host.label,state:s});}catch(error){states.push({label:host.label,error:error.message});}return{restored:states.every(s=>s.state?.restored&&s.state.bindingRestored),reason,states};}
 };
 return io;
}
