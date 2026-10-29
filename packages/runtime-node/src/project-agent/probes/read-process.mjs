import { spawn } from 'node:child_process';

/** Fixed adapter commands only. Cancellation resolves after the child closes, never at abort notification. */
export function runReadProcess(command,args,{cwd,signal,timeoutMs=20_000,maxBytes=64*1024}={}) {
  if(signal?.aborted)return Promise.resolve({ok:false,reason:'cancelled'});
  return new Promise(resolve=>{
    let child,reason=null,bytes=0,stdout='',stderr='',killTimer=null,timer=null,finished=false;
    const stop=code=>{if(finished)return;reason ||= code;child?.kill('SIGTERM');killTimer ||= setTimeout(()=>child?.kill('SIGKILL'),1000);};
    const abort=()=>stop('cancelled');
    const finish=(code,error)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      resolve({ok:!reason&&!error&&code===0,reason:reason || (error?.code==='ENOENT'?'unavailable':error?'process_failed':code!==0?'nonzero':null),stdout,stderr,exitCode:code});};
    try{child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe'],shell:false});}catch(error){finish(null,error);return;}
    const collect=(chunk,kind)=>{bytes+=chunk.length;if(bytes>maxBytes){stop('output_limit');return;}if(kind==='stdout')stdout+=chunk.toString('utf8');else stderr+=chunk.toString('utf8');};
    child.stdout.on('data',chunk=>collect(chunk,'stdout'));child.stderr.on('data',chunk=>collect(chunk,'stderr'));
    child.on('error',error=>finish(null,error));child.on('close',code=>finish(code));
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    timer=setTimeout(()=>stop('timeout'),timeoutMs);
  });
}
