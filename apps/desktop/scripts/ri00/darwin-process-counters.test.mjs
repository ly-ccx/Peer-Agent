import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
test('libproc process time units agree with measured CPU and instruction counters advance',{skip:process.platform!=='darwin'},async t=>{
  const child=spawn('python3',[new URL('./darwin-process-counters.py',import.meta.url).pathname],{stdio:['pipe','pipe','pipe']});t.after(()=>child.kill('SIGTERM'));
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator](),ready=JSON.parse((await lines.next()).value);
  assert.equal(ready.abiBytes,296);assert.ok(ready.timebase.numer>0&&ready.timebase.denom>0);
  const read=async id=>{child.stdin.write(JSON.stringify({id,pid:process.pid})+'\n');const reply=JSON.parse((await lines.next()).value);assert.equal(reply.ok,true);return reply.point;};
  const before=await read(1),thread=process.threadCpuUsage();let elapsed=0,value=0;
  while(elapsed<30000){for(let i=0;i<10000;i++)value=(value+i)|0;const now=process.threadCpuUsage();elapsed=now.user+now.system-thread.user-thread.system;}
  const after=await read(2),delta=key=>Number(BigInt(after.values[key])-BigInt(before.values[key]));
  const cpuUs=(delta('ri_user_time')+delta('ri_system_time'))*ready.timebase.numer/ready.timebase.denom/1000;
  assert.ok(cpuUs>=elapsed*.7&&cpuUs<elapsed*3,`native ${cpuUs}us; thread ${elapsed}us`);
  assert.ok(delta('ri_cycles')>0&&delta('ri_instructions')>0);assert.ok(after.threads.length>0);assert.equal(before.values.ri_proc_start_abstime,after.values.ri_proc_start_abstime);
  assert.equal(ready.threadIdKind,'unique-kernel-id');
  assert.equal(ready.perLevelStructBytes,8+40*ready.perLevelNames.length);
  const old=new Map(before.threads.map(row=>[row.id,row]));
  const changes=after.threads.filter(row=>row.perLevel&&old.get(row.id)?.perLevel).map(row=>{
    let ticks=0,instructions=0,cycles=0;
    for(let i=0;i<row.perLevel.length;i++){
      const a=old.get(row.id).perLevel[i],b=row.perLevel[i];assert.equal(b.name,a.name);
      for(const key of ['instructions','cycles','userTicks','systemTicks'])assert.ok(BigInt(b[key])>=BigInt(a[key]));
      ticks+=Number(BigInt(b.userTicks)+BigInt(b.systemTicks)-BigInt(a.userTicks)-BigInt(a.systemTicks));
      instructions+=Number(BigInt(b.instructions)-BigInt(a.instructions));cycles+=Number(BigInt(b.cycles)-BigInt(a.cycles));
    }
    return {cpuUs:ticks*ready.timebase.numer/ready.timebase.denom/1000,instructions,cycles};
  });
  const busiest=changes.sort((a,b)=>b.cpuUs-a.cpuUs)[0];assert.ok(busiest);
  assert.ok(busiest.cpuUs>=elapsed*.7&&busiest.cpuUs<elapsed*3);assert.ok(busiest.instructions>0&&busiest.cycles>0);
});
