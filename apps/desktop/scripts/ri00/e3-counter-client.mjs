import{spawn}from'node:child_process';import{createInterface}from'node:readline';import{fileURLToPath}from'node:url';
export async function startE3Counter(){
 const child=spawn('python3',[fileURLToPath(new URL('./darwin-process-counters.py',import.meta.url))],{stdio:['pipe','pipe','pipe']});
 const closed=new Promise(r=>child.once('close',r));let sequence=0,resolveReady,rejectReady,stderr='';const pending=new Map();
 const readyPromise=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;}),startup=setTimeout(()=>rejectReady(Error('e3_counter_start_timeout')),5000);
 child.stderr.on('data',b=>{if(stderr.length<32768)stderr+=b;});
 createInterface({input:child.stdout}).on('line',line=>{try{const x=JSON.parse(line);if(x.ready){clearTimeout(startup);resolveReady(x);return;}const p=pending.get(x.id);if(!p)return;pending.delete(x.id);clearTimeout(p.timer);x.ok?p.resolve(x.point):p.reject(Error('e3_counter_read_failed'));}catch(e){rejectReady(e);}});
 child.once('error',rejectReady);child.once('close',()=>{clearTimeout(startup);rejectReady(Error('e3_counter_disconnected'));for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('e3_counter_disconnected'));}pending.clear();});
 const api={read(pid){return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(Error('e3_counter_timeout'));},3000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,pid})+'\n');});},async close(){child.stdin.end();child.kill('SIGTERM');await closed;return {stderr};}};
 try{api.ready=await readyPromise;return api;}catch(e){await api.close();throw e;}
}
