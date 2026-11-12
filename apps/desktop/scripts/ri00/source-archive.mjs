import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';import{DatabaseSync,backup}from'node:sqlite';
import{resolveDestination}from'./identity.mjs';
import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function sourceInventory(root,coordinationDirectory){
  const entries=[];function addTree(label,base,relative='',kind='canonical'){
    const visit=(file,relative)=>{const s=fs.lstatSync(file,{bigint:true});
      if(s.isSymbolicLink())throw Error('source_archive_symlink_not_supported');
      if(s.isDirectory()&&kind!=='fence-directory'){for(const name of fs.readdirSync(file).sort())visit(path.join(file,name),path.join(relative,name));return;}
      if(kind==='fence-directory'&&!s.isDirectory())throw Error('source_archive_writer_fence_required');
      if(kind!=='fence-directory'&&!s.isFile())throw Error('source_archive_regular_files_required');
      if(entries.length>=20000)throw Error('source_inventory_file_cap');
      entries.push({label,relative,file,kind,size:kind==='fence-directory'?0:Number(s.size),stat:['dev','ino','size','mtimeNs','ctimeNs'].map(k=>String(s[k]))});};visit(base,relative);
  }
  for(const label of['goal-plans','conversations','projects'])addTree(label,path.join(root,label));
  addTree('coordination',path.join(coordinationDirectory,'coordination-v2'),'coordination-v2');
  for(const name of['coordination-fence.json','coordination-recovery.json'])if(fs.existsSync(path.join(coordinationDirectory,name)))addTree('coordination',path.join(coordinationDirectory,name),name);
  addTree('coordination',path.join(coordinationDirectory,'coordination.jsonl'),'coordination.jsonl','fence-directory');
  const pointerFile=path.join(coordinationDirectory,'.read-models','coordination-current.json');
  addTree('coordination',pointerFile,'.read-models/coordination-current.json');const pointer=JSON.parse(fs.readFileSync(pointerFile,'utf8'));
  if(pointer.schemaVersion!==1||!/^coordination-[a-f0-9-]{36}\.sqlite$/.test(pointer.file||''))throw Error('source_archive_current_sqlite_pointer_required');
  addTree('coordination',path.join(coordinationDirectory,'.read-models',pointer.file),path.join('.read-models',pointer.file),'sqlite');
  return {entries,sha256:sha(JSON.stringify(entries.map(({label,relative,stat,kind})=>[label,relative,kind,kind==='sqlite'?'revision-bound-separately':stat]))),bytes:entries.reduce((s,e)=>s+e.size,0)};
}
/** Controller only: preserve canonical files and a SQLite backup without touching source writers. */
export async function archiveSource(root,coordinationDirectory,destination,{remainingBytes,maxFiles=20000,expectedRevision}={}){
  if(!Number.isFinite(remainingBytes)||remainingBytes<0||fs.existsSync(destination))throw Error('bounded_new_source_archive_required');
  if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw Error('source_archive_revision_required');
  destination=resolveDestination(destination);for(const source of[root,coordinationDirectory].map(x=>fs.realpathSync(x)))if(destination===source||destination.startsWith(source+path.sep))throw Error('source_archive_destination_must_be_isolated');
  const before=sourceInventory(root,coordinationDirectory);
  if(before.bytes>remainingBytes||before.entries.length>maxFiles)throw Error('source_archive_budget_exhausted');
  fs.mkdirSync(destination,{recursive:true,mode:0o700});let bytes=0;const manifest=[],buffer=Buffer.allocUnsafe(1048576);
  for(const e of before.entries){
    const to=path.join(destination,e.label,e.relative);fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});
    if(e.kind==='fence-directory'){fs.mkdirSync(to,{mode:0o700});manifest.push({label:e.label,relative:e.relative,kind:e.kind,size:0,contentsNotArchived:true});continue;}
    if(e.kind==='sqlite'){const db=new DatabaseSync(e.file,{readOnly:true});try{await backup(db,to);}finally{db.close();}
      const snapshot=new DatabaseSync(to,{readOnly:true});try{const revision=JSON.parse(snapshot.prepare('SELECT value FROM meta WHERE id=?').get('revision')?.value??'null');
        if(revision!==expectedRevision)throw Error('source_archive_sqlite_revision_mismatch');}finally{snapshot.close();}}
    else fs.copyFileSync(e.file,to,fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(to,0o600);const n=fs.statSync(to).size;bytes+=n;
    if(bytes>remainingBytes)throw Error('source_archive_budget_exhausted');
    const digest=createHash('sha256'),fd=fs.openSync(to,'r');try{let count;while((count=fs.readSync(fd,buffer,0,buffer.length,null)))digest.update(buffer.subarray(0,count));}finally{fs.closeSync(fd);}
    manifest.push({label:e.label,relative:e.relative,size:n,sha256:digest.digest('hex')});
  }
  const after=sourceInventory(root,coordinationDirectory),consistent=before.sha256===after.sha256;
  const receipt={beforeSha256:before.sha256,afterSha256:after.sha256,consistent,bytes,files:manifest.length,coordinationRevision:expectedRevision,
    scope:'three-stores+current-coordination-canonical-and-sqlite; fenced directory identity only; excludes prior writer attempts and recovery inventories',
    strictWriterFenceAndOriginalInodeReplayNotSupported:true,manifestSha256:sha(JSON.stringify(manifest))};
  fs.writeFileSync(path.join(destination,'manifest.private.json'),JSON.stringify({receipt,manifest}),{mode:0o600});
  if(!consistent)throw Error('source_changed_during_archive');return receipt;
}

export function archiveSourceBounded(root,coordinationDirectory,destination,options,{timeoutMs=30000,signal}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('bounded_archive_worker_timeout_required');
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--max-old-space-size=128',fileURLToPath(import.meta.url),'--owned-archive-worker'],{stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',timedOut=false,overflow=false,aborted=false;
    const abort=()=>{aborted=true;child.kill('SIGKILL');};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    for(const [stream,key]of[[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',b=>{if(key==='stdout')stdout+=b;else stderr+=b;if(stdout.length+stderr.length>32768){overflow=true;child.kill('SIGKILL');}});
    child.once('error',error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error);});
    child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(aborted)return reject(Error('source_archive_worker_aborted'));if(timedOut)return reject(Error('source_archive_worker_timeout'));if(overflow)return reject(Error('source_archive_worker_output_cap'));
      if(code!==0)return reject(Error('source_archive_worker_failed:exit-'+code+':'+stderr.trim().slice(0,256)));
      try{resolve(JSON.parse(stdout));}catch{reject(Error('source_archive_worker_invalid_receipt'));}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({root,coordinationDirectory,destination,options,ownerPid:process.pid}));
  });
}
if(process.argv[2]==='--owned-archive-worker'&&process.argv[1]===fileURLToPath(import.meta.url)){
  const began=process.cpuUsage(),deadline=setTimeout(()=>process.exit(124),30000);let parentWatch;
  try{const input=fs.readFileSync(0,'utf8');if(Buffer.byteLength(input)>16384)throw Error('archive_worker_config_cap');
    const {root,coordinationDirectory,destination,options,ownerPid}=JSON.parse(input);if(process.ppid!==ownerPid)throw Error('archive_controller_lost');
    parentWatch=setInterval(()=>{if(process.ppid!==ownerPid)process.exit(125);},1000);parentWatch.unref();
    const receipt=await archiveSource(root,coordinationDirectory,destination,options),cpu=process.cpuUsage(began);
    process.stdout.write(JSON.stringify({...receipt,workerCpuMs:(cpu.user+cpu.system)/1000}));
  }catch(error){process.stderr.write(error.message);process.exitCode=1;}finally{clearTimeout(deadline);clearInterval(parentWatch);}
}
