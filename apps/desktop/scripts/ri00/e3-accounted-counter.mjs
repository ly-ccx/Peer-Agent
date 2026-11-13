import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

// The sealed read(pid) script is unchanged. This single-threaded launcher adds only its own cumulative CPU and EOF receipt.
const launcher=String.raw`import builtins,json,os,resource,runpy,sys
original_print=builtins.print
def accounted_print(*args,**kwargs):
    value=json.loads(args[0])
    usage=resource.getrusage(resource.RUSAGE_SELF)
    value['counterSelfCpuMs']=(usage.ru_utime+usage.ru_stime)*1000
    if value.get('ready'): value['counterPid']=os.getpid()
    original_print(json.dumps(value),**kwargs)
builtins.print=accounted_print
try:
    runpy.run_path(sys.argv[1],run_name='__main__')
finally:
    builtins.print=original_print
    usage=resource.getrusage(resource.RUSAGE_SELF)
    original_print(json.dumps({'accountedCounterFinal':True,'cpuMs':(usage.ru_utime+usage.ru_stime)*1000}),flush=True)
`;
export async function startAccountedE3Counter(scriptPath) {
  const child=spawn('python3',['-c',launcher,scriptPath],{stdio:['pipe','pipe','pipe']});
  let seq=0,readyResolve,readyReject,final,selfCpuMs=0,stderr='',closedFlag=false;
  const pending=new Map(),readyPromise=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}),timer=setTimeout(()=>readyReject(Error('e3_accounted_counter_ready_timeout')),5000);
  const closed=new Promise(resolve=>child.once('close',(code,signal)=>{closedFlag=true;clearTimeout(timer);readyReject(Error('e3_accounted_counter_closed'));for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('e3_accounted_counter_disconnected'));}pending.clear();resolve({code,signal});}));
  child.on('error',readyReject);child.stderr.on('data',b=>{if(stderr.length<32768)stderr+=b;});
  createInterface({input:child.stdout}).on('line',line=>{try{const value=JSON.parse(line);
    if(value.accountedCounterFinal){final=value;return;}
    if(!Number.isFinite(value.counterSelfCpuMs)||value.counterSelfCpuMs<selfCpuMs)throw Error('e3_counter_cpu_invalid');selfCpuMs=value.counterSelfCpuMs;
    if(value.ready){clearTimeout(timer);readyResolve(value);return;}
    const p=pending.get(value.id);if(!p)return;pending.delete(value.id);clearTimeout(p.timer);value.ok?p.resolve(value.point):p.reject(Error('e3_accounted_counter_read_failed'));
  }catch(error){readyReject(error);for(const p of pending.values()){clearTimeout(p.timer);p.reject(error);}pending.clear();}});
  const api={get selfCpuMs(){return selfCpuMs;},pid:child.pid,
    read(pid){if(closedFlag)return Promise.reject(Error('e3_accounted_counter_closed'));return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('e3_accounted_counter_rpc_timeout'));},3000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,pid})+'\n');});},
    async close(){const before=performance.now(),hadPending=pending.size>0;child.stdin.end();let timeout;await Promise.race([closed,new Promise(r=>{timeout=setTimeout(r,1000);})]);clearTimeout(timeout);
      let forced=false;if(!closedFlag){forced=true;child.kill('SIGTERM');}const exit=await closed;
      return {exit,stderr,finalCpuMs:final?.cpuMs??null,shutdownReserveMs:1000,shutdownElapsedMs:performance.now()-before,forced,
        known:!forced&&!hadPending&&exit.code===0&&Number.isFinite(final?.cpuMs)&&final.cpuMs>=selfCpuMs&&pending.size===0};}
  };
  try{api.ready=await readyPromise;return api;}catch(error){await api.close();throw error;}
}
