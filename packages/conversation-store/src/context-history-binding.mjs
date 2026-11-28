// Small derived cache only; canonical JSONL remains the source of every binding.
import {openSync,closeSync,fstatSync,statSync,readSync,constants} from 'node:fs';
import {normalizeCompactionHistorySelection} from '@peer-agent/protocol';
const cache=new Map();
const token=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
function selectionScan() {
  const identities=new Map();let last=null,index=0;
  return {
    accept(row) {
      const object=value=>value && typeof value==='object' && !Array.isArray(value);
      const marker=object(row._compaction)?row._compaction:object(row.compaction)?row.compaction:null;
      const id=typeof row.id==='string'?row.id:'';
      if(id){const prior=identities.get(id);identities.set(id,prior?{...prior,count:prior.count+1}:{index,count:1,allowed:!marker && ['user','assistant','tool'].includes(row.role) && !['agent_message','agent_activity'].includes(row.kind)});}
      if(marker){
        const selection=marker.historySelection===undefined?null:normalizeCompactionHistorySelection(marker.historySelection);
        if(marker.historySelection!==undefined && !selection)throw Error('invalid selection');
        if(selection && (!id.trim() || typeof marker.summary!=='string' || !marker.summary.trim()))throw Error('invalid boundary');
        last={index,id:id.trim()?id:`compaction_${index}`,selection};
      }
      index++;
    },
    finish() {
      if(!last)return {projectorVersion:3,compactionBoundaryId:null,compactionEpoch:0,selectionVersion:0};
      let previous=-1;
      for(const id of last.selection?.retainedMessageIds??[]){
        const found=identities.get(id);
        if(!found || found.count!==1 || !found.allowed || found.index>=last.index || found.index<=previous)throw Error('invalid selection identity');
        previous=found.index;
      }
      return {projectorVersion:3,compactionBoundaryId:last.id,compactionEpoch:last.selection?.compactionEpoch??0,selectionVersion:last.selection?1:0};
    },
  };
}
export function contextHistoryBinding(rows) {
  try{const scan=selectionScan();for(const row of rows)scan.accept(row);return scan.finish();}catch{return null;}
}
/** Bounded strict scan. Unsupported/unstable sources yield unknown, never 0%. */
export function readContextHistoryBinding(file) {
  let fd;
  try {
    fd=openSync(file,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
    const before=fstatSync(fd);if(!before.isFile() || before.size>8*1024*1024)return null;
    const key=token(before),cached=cache.get(file);
    if(cached?.key===key){cache.delete(file);cache.set(file,cached);return cached.binding;}
    const chunk=Buffer.alloc(32768),decoder=new TextDecoder('utf-8',{fatal:true});let pieces=[],bytes=0;
    const scan=selectionScan();
    const consume=()=>{
      const text=decoder.decode(Buffer.concat(pieces,bytes));pieces=[];bytes=0;
      if(!text.trim())return;
      const row=JSON.parse(text);if(!row||typeof row!=='object'||Array.isArray(row))throw Error('invalid history');
      scan.accept(row);
    };
    let count;
    while((count=readSync(fd,chunk,0,chunk.length,null))>0){
      let start=0;for(let i=0;i<count;i++){if(chunk[i]!==10)continue;
        pieces.push(Buffer.from(chunk.subarray(start,i)));bytes+=i-start;if(bytes>1024*1024)throw Error('record limit');consume();start=i+1;
      }
      if(start<count){pieces.push(Buffer.from(chunk.subarray(start,count)));bytes+=count-start;if(bytes>1024*1024)throw Error('record limit');}
    }
    if(bytes)throw Error('incomplete history');
    if(token(fstatSync(fd))!==key || token(statSync(file))!==key)return null;
    const binding=scan.finish();
    cache.delete(file);cache.set(file,{key,binding});while(cache.size>64)cache.delete(cache.keys().next().value);
    return binding;
  } catch(error) {
    if(error?.code==='ENOENT')return contextHistoryBinding([]);
    return null;
  } finally {if(fd!==undefined)closeSync(fd);}
}
export function contextSnapshotMatchesBinding(snapshot,binding) {
  if(!binding || !snapshot || typeof snapshot!=='object')return false;
  if(binding.selectionVersion===1 && (snapshot.projectorVersion!==3 || snapshot.compactionBoundaryId!==binding.compactionBoundaryId || snapshot.compactionEpoch!==binding.compactionEpoch))return false;
  if(snapshot.compactionBoundaryId!==undefined && snapshot.compactionBoundaryId!==binding.compactionBoundaryId)return false;
  if(snapshot.projectorVersion!==undefined && snapshot.projectorVersion!==3)return false;
  return true;
}
