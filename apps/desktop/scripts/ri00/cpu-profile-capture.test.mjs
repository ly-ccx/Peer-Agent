import test from'node:test';import assert from'node:assert/strict';import{captureCpuProfile}from'./cpu-profile-capture.mjs';
test('normal CPU capture owns start/stop/disable and saves the returned profile',async()=>{
 const calls=[],saved=[];const profile={nodes:[{}]};await captureCpuProfile({post:async m=>{calls.push(m);return {profile};},read:async()=>({userMs:10}),save:r=>saved.push(r)});
 assert.equal(saved.length,1);assert.equal(saved[0].profile,profile);assert.equal(saved[0].complete,true);assert.equal(saved[0].rows.length,3);assert.deepEqual(calls,['Profiler.enable','Profiler.setSamplingInterval','Profiler.start','Profiler.stop','Profiler.disable']);
 await assert.rejects(captureCpuProfile({post:()=>{throw Error('must_not_enable');}},4),/bounded_profile_read_count/);
});
test('a budget/read failure saves executed rows and partial profile without masking its error',async()=>{
 const failure=Error('budget'),profile={nodes:[{}]},saved=[],calls=[];await assert.rejects(captureCpuProfile({post:async m=>{calls.push(m);return {profile};},read:async()=>({userMs:10}),onRead:()=>{throw failure;},save:r=>saved.push(r)}),e=>e===failure);
 assert.equal(saved[0].complete,false);assert.equal(saved[0].rows.length,1);assert.equal(saved[0].profile,profile);assert.equal(calls.at(-1),'Profiler.disable');
});
test('unknown start outcomes still attempt owned cleanup; cleanup errors remain explicit',async()=>{
 const start=Error('start-reply-lost'),stop=Error('stop-failed'),calls=[],errors=[];
 await assert.rejects(captureCpuProfile({post:async m=>{calls.push(m);if(m==='Profiler.start')throw start;if(m==='Profiler.stop')throw stop;return {};},read:()=>{},save:()=>{},onCleanupError:(phase,error)=>errors.push({phase,error})}),e=>e===start);
 assert.equal(calls.at(-1),'Profiler.disable');assert.equal(errors[0].error,stop);
 await assert.rejects(captureCpuProfile({post:async m=>{if(m==='Profiler.disable')throw stop;return {profile:{nodes:[]}};},read:()=>({}),save:()=>{}}),e=>e===stop);
});
