import test from 'node:test';
import assert from 'node:assert/strict';
import { browserMainCounterDelta } from './thread-counter-delta.mjs';
const row=(id='1',value='0')=>({id,category:'browser-main',perLevel:[{name:'Performance',instructions:value,cycles:value,userTicks:value,systemTicks:value,energyNj:value}]});
test('main PMCs use per-thread perf levels and retain outside-window CPU including negative values',()=>{
  const a={threads:[row()]},b={threads:[row('1','1000')]};
  const r=browserMainCounterDelta(a,b,{numer:1,denom:1},1);
  assert.equal(r.available,true);assert.equal(r.levels[0].instructions,'1000');assert.equal(r.cpuMs,.002);assert.equal(r.outsideMeasuredCpuMs,-.998);
  assert.equal(browserMainCounterDelta(a,b,{numer:1,denom:1},10).exclusiveWindow,false);
});
test('missing counters, changed thread ID and regressing counters are unavailable, never zero',()=>{
  assert.equal(browserMainCounterDelta({threads:[row()]},{threads:[row('2')]},{numer:1,denom:1},0).available,false);
  assert.equal(browserMainCounterDelta({threads:[row('1','100')]},{threads:[row()]},{numer:1,denom:1},0).available,false);
  const x=row();x.perLevel=null;assert.equal(browserMainCounterDelta({threads:[x]},{threads:[row()]},{numer:1,denom:1},0).available,false);
});
