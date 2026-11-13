import fs from'node:fs';
import{browserMainCounterDelta}from'./thread-counter-delta.mjs';

export function createE3Journal(file,{maxBytes=33554432,sync=fs.fdatasyncSync,beforeWrite=()=>{}}={}){
 const fd=fs.openSync(file,'wx',0o600);let bytes=0,seq=0,closed=false;
 return{append(kind,value){if(closed)throw Error('e3_journal_closed');const line=JSON.stringify({seq:++seq,kind,value})+'\n',n=Buffer.byteLength(line);if(bytes+n>maxBytes)throw Error('e3_journal_byte_cap');beforeWrite(n);fs.writeFileSync(fd,line);bytes+=n;sync(fd);return{seq,bytes,durable:true};},get bytes(){return bytes;},close(){if(!closed){closed=true;fs.closeSync(fd);}}};
}
/** Owns the controller slot and ACK ordering; unknown request responses never allocate a second ticket. */
export function createE3DurableReader({rpc,journal,counter,pid,timebase,charge=()=>{},now=()=>performance.now(),wait=ms=>new Promise(r=>setTimeout(r,ms))}){
 let next=0,busy=false,pendingArchive=null;const billed=new Set();
 function bill(rows){const fresh=rows.filter(r=>{const key=JSON.stringify([r.origin,r.start,r.end,r.ticketId??null]);if(billed.has(key))return false;billed.add(key);return true;});charge(fresh);}
 async function archive({id=null,before=null,after=null,ticket=null,label='passive'}={}){
  const batch=await rpc('take'),entries=await rpc('takeEntries'),record={id,label,before,after,ticket,batch,entries};pendingArchive=record;
  const rows=batch.rows||[];bill(rows); // Known executed rows are billed even when fsync/ACK fails.
  journal.append('read-and-entry-batch',record);
  await rpc('ackBatch');await rpc('ackEntries');if(id!==null)await rpc('ackTicket',{id});pendingArchive=null;
  if(batch.state.metadataErrors||batch.state.dropped||batch.state.gcDropped||batch.state.ledgerOverflows||entries.state.metadataErrors)throw Error('e3_reader_metadata_invalid');
  return record;
 }
 return{
  async read(kind,label){if(busy||pendingArchive)throw Error('e3_reader_slot_busy');busy=true;const id=++next;let ticket,before,after;
   try{await rpc('renew');before=counter?await counter.read(pid):null;
    try{ticket=await rpc('request',{id,kind,label});}catch(error){journal.append('request-response-unknown',{id,message:error.message});ticket=await rpc('status',{id});if(!ticket||ticket.state==='unknown')throw Error('e3_reader_request_outcome_unknown');}
    const deadline=now()+6000;while(!['completed','failed','expired','acknowledged'].includes(ticket.state)){if(now()>=deadline)throw Error('e3_reader_ticket_timeout');await wait(2);ticket=await rpc('status',{id});}
    after=counter?await counter.read(pid):null;const record=await archive({id,before,after,ticket,label}),rows=record.batch.rows.filter(r=>r.ticketId===id);
    if(ticket.state!=='completed'||rows.length!==1)throw Error('e3_reader_ticket_'+ticket.state);
    const row=rows[0],pmc=counter?browserMainCounterDelta(before,after,timebase,row.userMs+row.systemMs):null;
    return{row,pmc,record};
   }finally{busy=false;}
  },
  async drain(label='natural'){if(busy||pendingArchive)throw Error('e3_reader_slot_busy');busy=true;try{return await archive({label});}finally{busy=false;}},
  async recoverArchive(){if(busy||!pendingArchive)throw Error('e3_reader_recovery_not_pending');busy=true;try{const record=pendingArchive;journal.append('recovered-unacknowledged-batch',record);bill(record.batch.rows||[]);await rpc('ackBatch');await rpc('ackEntries');if(record.id!==null)await rpc('ackTicket',{id:record.id});pendingArchive=null;return{recovered:true,noBusinessRead:true};}finally{busy=false;}},
  state(){return{busy,pendingArchive:Boolean(pendingArchive),nextId:next};}
 };
}
