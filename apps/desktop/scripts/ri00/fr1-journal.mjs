import fs from 'node:fs';
import {createHash}from'node:crypto';
/** Raw batches are stored once, with a replayable sequence and chunk hash chain before ACK. */
export function createFr1Journal(file,{maxBytes=134217728,sync=fs.fdatasyncSync}={}){
 const fd=fs.openSync(file,'wx',0o600);let bytes=0,chunk=0,previous='0'.repeat(64),lastSeq=0,pending=null,closed=false,lastBatchSha,lastReceipt;
 const hash=v=>createHash('sha256').update(v).digest('hex');
 function commit(batch){if(lastBatchSha&&hash(JSON.stringify(batch))===lastBatchSha)return lastReceipt;if(closed)throw Error('fr1_journal_closed');if(pending&&pending.batch!==batch)throw Error('fr1_original_pending_batch_required');
  if(!pending){const records=batch.records;if(!Array.isArray(records)||records.some((r,i)=>r.seq!==lastSeq+i+1)||batch.throughSeq!==lastSeq+records.length)throw Error('fr1_history_sequence_gap');
   const body={chunk:chunk+1,previous,batch},content=JSON.stringify(body),digest=hash(content),line=JSON.stringify({...body,sha256:digest})+'\n';
   if(bytes+Buffer.byteLength(line)>maxBytes)throw Error('fr1_journal_cap');pending={batch,line,digest,throughSeq:batch.throughSeq,written:false};}
  if(!pending.written){fs.writeFileSync(fd,pending.line);bytes+=Buffer.byteLength(pending.line);pending.written=true;}sync(fd);
  const receipt={chunk:++chunk,sha256:pending.digest,throughSeq:pending.throughSeq};previous=pending.digest;lastSeq=pending.throughSeq;lastBatchSha=hash(JSON.stringify(batch));lastReceipt=receipt;pending=null;return receipt;
 }
 return {commit,get bytes(){return bytes;},get pending(){return pending?.batch||null;},state:()=>({bytes,chunk,previous,lastSeq,pending:Boolean(pending)}),close(){if(!closed){closed=true;fs.closeSync(fd);}}};
}
export function replayFr1Journal(text){let previous='0'.repeat(64),seq=0,chunk=0;const records=[];
 for(const line of text.trim().split('\n').filter(Boolean)){const x=JSON.parse(line),{sha256,...body}=x;const h=createHash('sha256').update(JSON.stringify(body)).digest('hex');
  if(sha256!==h||x.previous!==previous||x.chunk!==++chunk)throw Error('fr1_chunk_chain_invalid');
  for(const r of x.batch.records){if(r.seq!==++seq)throw Error('fr1_history_sequence_gap');records.push(r);}if(x.batch.throughSeq!==seq)throw Error('fr1_batch_sequence');previous=sha256;
 }return{records,seq,chunk,sha256:previous};}
