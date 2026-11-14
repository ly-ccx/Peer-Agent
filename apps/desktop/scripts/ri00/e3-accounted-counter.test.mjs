import test from 'node:test';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {startAccountedE3Counter} from './e3-accounted-counter.mjs';
test('real read-only counter carries cumulative auxiliary CPU and a graceful final receipt',async()=>{
  const counter=await startAccountedE3Counter(fileURLToPath(new URL('./darwin-process-counters.py',import.meta.url)));
  try{const point=await counter.read(process.pid);assert.ok(point.values.ri_proc_start_abstime);assert.equal(counter.ready.counterPid,counter.pid);assert.ok(counter.selfCpuMs>0);}
  finally{const end=await counter.close();assert.equal(end.known,true);assert.ok(end.finalCpuMs>0);assert.equal(end.shutdownReserveMs,1000);}
  await assert.rejects(counter.read(process.pid),/closed/);
});
