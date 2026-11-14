import {createHash} from 'node:crypto';
import {installFr1Recorder} from './fr1-recorder.mjs';
import {fr1InstallDeclaration} from './fr1-install.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
/** Explicit one-occurrence seams. No fallback to a guessed or partially instrumented source. */
export function fr1StageSource(base=installFr1Recorder.toString()) {
  if(sha(base)!=='e7e374e97a4cbca961036f67705ddfbc8824bfeceefc6c28f1cde7cb3ca864b8')throw Error('fr1_stage_base_version');
  let source=base;const seams=[];
  function replace(name,from,to){
    if(source.split(from).length!==2)throw Error('fr1_stage_source_seam:'+name);
    source=source.replace(from,to);seams.push({name,originalSha256:sha(from)});
  }
  replace('owned-only','  const cap={',`  const diag=globalThis.__fr1StageMeter;
  if(!globalThis.__fr1OwnedChecks||!diag||diag.owner!==ownerId)throw Error('fr1_stage_owned_only');
  const cap={`);
  replace('hash','  const hash=v=>crypto.createHash(\'sha256\').update(v).digest(\'hex\');',
    `  const hash=v=>{const stage=Buffer.isBuffer(v)?'hash.output':'hash.metadata';diag.begin(stage);try{return crypto.createHash('sha256').update(v).digest('hex');}finally{diag.end(stage);}};`);
  replace('stamp',"  const stamp=()=>{const s=fs.statSync(indexFile,{bigint:true});return hash(JSON.stringify(['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k]))));};",
    `  const stamp=()=>{let s,text;diag.begin('source.stat');try{s=fs.statSync(indexFile,{bigint:true});}finally{diag.end('source.stat');}
      diag.begin('source.json');try{text=JSON.stringify(['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k])));}finally{diag.end('source.json');}return hash(text);};`);
  replace('record-encoding','const bytes=Buffer.byteLength(JSON.stringify(row));',
    `let text,bytes;diag.begin('record.json');try{text=JSON.stringify(row);}finally{diag.end('record.json');}diag.begin('record.byte-size');try{bytes=Buffer.byteLength(text);}finally{diag.end('record.byte-size');}`);
  replace('record-queue','seq++;records.push(row);retainedBytes+=bytes;note();return row.seq;',
    `diag.begin('record.queue');try{seq++;records.push(row);retainedBytes+=bytes;note();}finally{diag.end('record.queue');}return row.seq;`);
  replace('stack-native','const sites=getCallSites(cap.frames,{sourceMap:false});',
    `let sites;diag.begin('stack.capture');try{sites=getCallSites(cap.frames,{sourceMap:false});}finally{diag.end('stack.capture');}`);
  replace('stack-map-start','const frames=sites.map(f=>',`let frames;diag.begin('stack.map');try{frames=sites.map(f=>`);
  replace('stack-map-end','return[f.functionName,f.scriptId,f.lineNumber,f.columnNumber];});',
    `return[f.functionName,f.scriptId,f.lineNumber,f.columnNumber];});}finally{diag.end('stack.map');}`);
  replace('stack-signature','const signature=JSON.stringify(frames),truncated=',
    `let signature;diag.begin('stack.signature-json');try{signature=JSON.stringify(frames);}finally{diag.end('stack.signature-json');}const truncated=`);
  replace('stack-lookup','if(stackIds.has(signature))return{id:stackIds.get(signature),truncated:false};',
    `let existing=null;diag.begin('stack.lookup');try{if(stackIds.has(signature))existing=stackIds.get(signature);}finally{diag.end('stack.lookup');}if(existing!==null)return{id:existing,truncated:false};`);
  replace('root-pre-start','const metadataStart=cpu();let r;',`const metadataStart=cpu();diag.begin('root.pre',rootId+1);let r;`);
  replace('root-pre-failure',"}catch(e){metadataErrors++;fatal('root-start:'",` }catch(e){diag.endIfOpen('root.pre');metadataErrors++;fatal('root-start:'`);
  replace('root-pre-end','r.start=performance.now();const before=',`diag.end('root.pre');r.start=performance.now();const before=`);
  replace('root-post-start','const afterStart=cpu();try{',`const afterStart=cpu();diag.begin('root.post',r.id);try{`);
  replace('output-encoding','const bytes=Buffer.from(JSON.stringify(value instanceof Map?[...value]:value));',
    `let text,bytes;diag.begin('output.json');try{text=JSON.stringify(value instanceof Map?[...value]:value);}finally{diag.end('output.json');}
      diag.begin('output.utf8');try{bytes=Buffer.from(text);}finally{diag.end('output.utf8');}`);
  replace('root-post-end','r.postSelfMs=cpu()-afterStart;',`diag.end('root.post');r.postSelfMs=cpu()-afterStart;`);
  replace('root-keep',"const keepStart=cpu();append('root',r);const totalSelf=",`const keepStart=cpu();diag.begin('root.keep',r.id);append('root',r);diag.end('root.keep');const totalSelf=`);
  replace('span-pre-start',"const r=activeRoot,meta=cpu();port('index');",`const r=activeRoot,meta=cpu();diag.begin('span.pre',r.id,r.evidence.length);port('index');`);
  replace('span-pre-end','const before=process.threadCpuUsage(),pre=',`diag.end('span.pre');const before=process.threadCpuUsage(),pre=`);
  replace('span-post',
    'finally{const end=performance.now(),c=process.threadCpuUsage(before),tail=(before.user+before.system+c.user+c.system)/1000,e={position:r.evidence.length,start,end,userMs:c.user/1000,systemMs:c.system/1000,rows:Array.isArray(value)?value.length:null,readFailure:failed,entryStack:stack,selfMs:0};r.evidence.push(e);e.selfMs=pre+cpu()-tail;}',
    `finally{const end=performance.now(),c=process.threadCpuUsage(before),tail=(before.user+before.system+c.user+c.system)/1000;
      diag.begin('span.post',r.id,r.evidence.length);const e={position:r.evidence.length,start,end,userMs:c.user/1000,systemMs:c.system/1000,rows:Array.isArray(value)?value.length:null,readFailure:failed,entryStack:stack,selfMs:0};r.evidence.push(e);diag.end('span.post');e.selfMs=pre+cpu()-tail;}`);
  let clockSite=0;
  source=source.replace(/process\.threadCpuUsage\(([^)]*)\)/g,(_all,args)=>`diag.originalClock(${args||'undefined'},${++clockSite})`);
  if(clockSite!==8)throw Error('fr1_stage_clock_site_count:'+clockSite);
  return{source,seams,clockSites:clockSite,baseFunctionSha256:sha(base),generatedSha256:sha(source),
    gateUnchanged:source.includes('if(totalSelf>cap.rootSelfMs)')&&source.includes('rootSelfMs:2,selfMs:3000')};
}

export function fr1StageDeclaration(){
  const generated=fr1StageSource(),original=installFr1Recorder.toString(),declaration=fr1InstallDeclaration();
  if(declaration.split(original).length!==2)throw Error('fr1_stage_install_seam');
  return{...generated,declaration:declaration.replace(original,generated.source)};
}
