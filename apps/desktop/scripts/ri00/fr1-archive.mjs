import fs from'node:fs';import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';import{archiveSource}from'./source-archive.mjs';
/** One read-only copy; POSIX wait accounting includes worker return, not only a pre-exit snapshot. */
export async function archiveFr1Source(config){
 const child=spawn('/usr/bin/time',['-lp',process.execPath,'--max-old-space-size=128',fileURLToPath(import.meta.url),'--worker'],{detached:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},30000);
 child.stdout.on('data',b=>{stdout+=b;if(stdout.length>32768){try{process.kill(-child.pid,'SIGKILL');}catch{}}});child.stderr.on('data',b=>{if(stderr.length<32768)stderr+=b;});child.stdin.end(JSON.stringify({...config,controllerPid:process.pid}));
 let exit;try{exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});}finally{clearTimeout(timer);}
 const user=/^user\s+([0-9.]+)/m.exec(stderr),system=/^sys\s+([0-9.]+)/m.exec(stderr),cpuUpperMs=user&&system?(Number(user[1])+Number(system[1]))*1000+20:null;
 let value;try{value=JSON.parse(stdout);}catch{value={error:'archive-worker-output-invalid'};}
 return{...value,exit,timedOut,cpuUpperMs,accounting:stderr,known:cpuUpperMs!==null&&!timedOut};
}
if(process.argv[2]==='--worker'&&process.argv[1]===fileURLToPath(import.meta.url)){
 const input=JSON.parse(fs.readFileSync(0,'utf8')),deadline=setTimeout(()=>process.exit(124),30000),watch=setInterval(()=>{try{process.kill(input.controllerPid,0);}catch{process.exit(125);}},1000);watch.unref();
 try{const receipt=await archiveSource(input.root,input.coordinationDirectory,input.destination,{remainingBytes:input.remainingBytes,expectedRevision:input.expectedRevision});process.stdout.write(JSON.stringify({receipt}));}
 catch(e){process.stdout.write(JSON.stringify({error:e.message}));process.exitCode=1;}finally{clearTimeout(deadline);clearInterval(watch);}
}
