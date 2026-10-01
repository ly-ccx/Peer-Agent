import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectSchedule } from './scheduler-kernel.mjs';
const schedule={kind:'hourly',timezone:'UTC',everyHours:1};
test('shared schedule kernel chooses only the newest missed occurrence and preserves overlap/skip policy',()=>{
 const input={schedule,after:'2026-10-01T00:00:00Z',now:'2026-10-01T03:20:00Z'};
 assert.deepEqual(inspectSchedule(input),{due:'2026-10-01T03:00:00.000Z',next:'2026-10-01T04:00:00.000Z',missed:true});
 assert.equal(inspectSchedule({...input,active:true}).skippedReason,'overlap');
 assert.equal(inspectSchedule({...input,missedRunPolicy:'skip'}).skippedReason,'missed_policy');
 const consumed={...input,after:'2026-10-01T03:00:00.000Z'};assert.equal(inspectSchedule(consumed).due,null);
 assert.throws(()=>inspectSchedule({...input,now:'bad'}),/ISO/);
});
