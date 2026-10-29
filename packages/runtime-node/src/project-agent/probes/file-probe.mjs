import { createHash } from 'node:crypto';
import { realpathSync,openSync,readSync,fstatSync,closeSync,constants,readdirSync,existsSync,statSync } from 'node:fs';
import path from 'node:path';
const IGNORED=new Set(['.git','node_modules','dist','build','out','target','.next']);
export function safeWatchPath(relative){return typeof relative==='string'&&relative.length>0&&relative.length<=500&&!path.isAbsolute(relative)&&!relative.includes('\\')&&!relative.split('/').some(p=>p==='..'||IGNORED.has(p))&&!relative.startsWith('-');}
export function probeFile({workspacePath,relative,signal,maxBytes=1024*1024}={}) {
  if(!safeWatchPath(relative)||/[?*]/.test(relative))return {ok:false,unavailableReason:'file_path_invalid'};
  try{
    const root=realpathSync(workspacePath),file=realpathSync(path.resolve(root,relative)),inside=path.relative(root,file);
    if(inside==='..'||inside.startsWith(`..${path.sep}`)||path.isAbsolute(inside)||inside.split(path.sep).some(p=>IGNORED.has(p)))return {ok:false,unavailableReason:'file_outside_workspace'};
    if(signal?.aborted)return {ok:false,unavailableReason:'cancelled'};
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let content;
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>maxBytes)return {ok:false,unavailableReason:'file_limit'};
      const buffer=Buffer.alloc(maxBytes+1);const size=readSync(fd,buffer,0,buffer.length,0);
      if(size>maxBytes||fstatSync(fd).size>maxBytes)return {ok:false,unavailableReason:'file_limit'};content=buffer.subarray(0,size);
    }finally{closeSync(fd);}
    if(realpathSync(path.resolve(root,relative))!==file)return {ok:false,unavailableReason:'file_changed_during_probe'};
    const digest=createHash('sha256').update(content).digest('hex');
    return {ok:true,digest,summary:`${relative}: ${digest.slice(0,12)}`,value:digest,succeeded:true,severity:'info'};
  }catch(error){return {ok:false,unavailableReason:error?.code==='ENOENT'?'file_missing':'file_unavailable'};}
}
/** Bounded local path patterns for watchers; no traversal through symlinks or ignored build trees. */
export function expandWatchPaths(workspacePath,patterns,{limit=256}={}) {
  if(!Array.isArray(patterns)||patterns.some(p=>!safeWatchPath(p)))throw Error('file_path_invalid');
  const root=realpathSync(workspacePath),files=[],directories=[root];
  for(const pattern of patterns.filter(pattern=>!/[?*]/.test(pattern))){
    const target=path.resolve(root,pattern);if(!existsSync(target))continue;
    const relative=path.relative(root,realpathSync(target));
    if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw Error('file_outside_workspace');
  }
  if(patterns.every(pattern=>!/[?*]/.test(pattern)&&(!existsSync(path.resolve(root,pattern))||!statSync(path.resolve(root,pattern)).isDirectory()))){
    const parents=new Set();
    for(const pattern of patterns){const target=path.resolve(root,pattern);let parent=path.dirname(target);while(!existsSync(parent)&&parent!==root)parent=path.dirname(parent);
      const actualParent=realpathSync(parent),relativeParent=path.relative(root,actualParent);
      if(relativeParent==='..'||relativeParent.startsWith(`..${path.sep}`)||path.isAbsolute(relativeParent))throw Error('file_outside_workspace');
      parents.add(actualParent);
      if(existsSync(target)){const actual=realpathSync(target),relative=path.relative(root,actual);
        if(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw Error('file_outside_workspace');
        if(statSync(actual).isFile())files.push(pattern);
      }
    }
    return {files:[...new Set(files)].sort(),directories:[...parents],root};
  }

  const rules=patterns.map(watchGlob);let count=0;
  function walk(dir,depth=0){if(depth>32)throw Error('file_tree_limit');for(const entry of readdirSync(dir,{withFileTypes:true})){if(IGNORED.has(entry.name)||entry.isSymbolicLink())continue;if(++count>4096)throw Error('file_tree_limit');const file=path.join(dir,entry.name),relative=path.relative(root,file).split(path.sep).join('/');
    if(entry.isDirectory()){if(directories.length>=limit)throw Error('file_tree_limit');directories.push(file);walk(file,depth+1);}
    else if(entry.isFile()&&patterns.some((pattern,index)=>rules[index].test(relative)||(!/[?*]/.test(pattern)&&relative.startsWith(`${pattern}/`)))){if(files.length>=limit)throw Error('file_tree_limit');files.push(relative);}
  }}
  walk(root);return {files:files.sort(),directories,root};
}

function watchGlob(pattern){
    const parts=pattern.split('/');let expression='^';
    parts.forEach((part,index)=>{if(part==='**'){expression+=index===parts.length-1?'.*':'(?:.*/)?';return;}
      expression+=part.split('*').map(piece=>piece.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*');
      if(index<parts.length-1)expression+='/';
    });return new RegExp(expression+'$');
}
export function matchesWatchPath(relative,patterns){
 return safeWatchPath(relative)&&patterns.some(pattern=>!pattern.includes('*')?(relative===pattern||relative.startsWith(`${pattern}/`)||pattern.startsWith(`${relative}/`)):watchGlob(pattern).test(relative));
}
