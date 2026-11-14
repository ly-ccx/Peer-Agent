import fs from'node:fs';import{spawn}from'node:child_process';
/** Only the sampler child may be terminated on deadline; the subject PID is never signalled here. */
export async function fr1NativeSample(pid,file,{now=()=>performance.now(),timeoutMs=5000}={}){
 if(fs.existsSync(file))throw Error('fr1_native_fresh_file');const start=now(),child=spawn('/usr/bin/time',['-lp','/usr/bin/sample',String(pid),'2','1','-file',file],{detached:true,stdio:['ignore','ignore','pipe']});let stderr='',timedOut=false;
 child.stderr.on('data',x=>{if(stderr.length<8192)stderr+=x;});const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},timeoutMs);
 const end=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
 const bytes=fs.existsSync(file)?fs.statSync(file).size:0,user=/^user\s+([0-9.]+)/m.exec(stderr),system=/^sys\s+([0-9.]+)/m.exec(stderr),cpuUpperMs=user&&system?(Number(user[1])+Number(system[1]))*1000+20:null;return{start,end:now(),...end,timedOut,bytes,stderr,cpuUpperMs,complete:!timedOut&&end.code===0&&cpuUpperMs!==null&&cpuUpperMs<=3000&&bytes>0&&bytes<=8388608,jsSymbolsNotGuaranteed:true};
}
