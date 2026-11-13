import fs from'node:fs';import path from'node:path';import{createRequire}from'node:module';import{spawn}from'node:child_process';import{createInterface}from'node:readline';import{fileURLToPath}from'node:url';

/** Owns one fixture process and a fixed command protocol; never attaches to a user process. */
export async function startOwnedE3Host(config){
 if(!config.output||fs.existsSync(config.output))throw Error('e3_new_owned_output_required');fs.mkdirSync(config.output,{recursive:true,mode:0o700});
 const file=path.join(config.output,'config.private.json');fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});
 const require=createRequire(path.join(config.moduleRoot,'apps/desktop/package.json')),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 env.PEER_RI00_OWNED_CONFIG=file;
 const child=spawn(require('electron'),[...(config.inspect?['--inspect=0']:[]),fileURLToPath(new URL('./e3-owned-main.cjs',import.meta.url)),file],{env,stdio:['pipe','pipe','pipe']});
 const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));let stderr='',stdout='',seq=0,readyResolve,readyReject,readyTimer;
 const readyPromise=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;readyTimer=setTimeout(()=>reject(Error('e3_owned_ready_timeout')),15000);});
 const pending=new Map();child.stderr.on('data',b=>{if(stderr.length<1048576)stderr+=b;});
 createInterface({input:child.stdout}).on('line',line=>{if(!line.startsWith('@ri00@')){if(stdout.length<1048576)stdout+=line+'\n';return;}
  try{const x=JSON.parse(line.slice(6));if(x.event==='ready'){clearTimeout(readyTimer);readyResolve(x);return;}const p=pending.get(x.id);if(!p)return;pending.delete(x.id);clearTimeout(p.timer);x.error?p.reject(Object.assign(Error(x.error.message),{remoteName:x.error.name})):p.resolve(x.result);}catch(error){readyReject(error);}
 });
 child.once('error',e=>{clearTimeout(readyTimer);readyReject(e);});child.once('close',()=>{clearTimeout(readyTimer);readyReject(Error('e3_owned_exited_before_ready'));for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('e3_owned_disconnected'));}pending.clear();
  fs.writeFileSync(path.join(config.output,'stderr.private.txt'),stderr,{mode:0o600});fs.writeFileSync(path.join(config.output,'stdout.private.txt'),stdout,{mode:0o600});});
 const api={child,closed,output:config.output,
  rpc(method,args={}){return new Promise((resolve,reject)=>{if(child.exitCode!==null||child.signalCode!==null){reject(Error('e3_owned_process_closed'));return;}
   const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('e3_owned_rpc_timeout:'+method));},20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,args})+'\n');});},
  async close(options={}){let shutdownTimer;try{return await Promise.race([api.rpc('shutdown',options),new Promise((_,reject)=>{shutdownTimer=setTimeout(()=>reject(Error('e3_owned_shutdown_timeout')),5000);})]);}
   finally{clearTimeout(shutdownTimer);child.stdin.end();
    const settled=async ms=>{let timer;const value=await Promise.race([closed.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),ms);})]);clearTimeout(timer);return value;};
    if(!await settled(3000)){child.kill('SIGTERM');if(!await settled(1000)){child.kill('SIGKILL');if(!await settled(1000)){child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();if(!await settled(1000))throw Error('e3_owned_exit_unverified');}}}
   }}
 };
 try{api.ready=await readyPromise;return api;}catch(error){child.kill('SIGTERM');await closed;throw error;}
}
