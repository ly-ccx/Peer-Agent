import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWatchProbeRuntime} from './watch-probe-provider.mjs';
import {createWatchState} from './watch-state.mjs';

test('owned watch executes through Projection SDK Grant and Evidence, while lease and pause denial execute no probe',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'watch-runtime-'));let lease=true,calls=0;
 const objective={objectiveId:'o',status:'active',milestones:[],watches:[{watchId:'w',kind:'schedule',probe:{type:'deterministic',check:'file_hash',spec:{path:'a.txt'}}}]};
 try{
  writeFileSync(path.join(root,'a.txt'),'actual');
  const runtime=createWatchProbeRuntime({resolveObjective:(ws,id)=>ws==='ws'&&id==='o'?objective:null,canObserve:()=>lease,resolveWorkspacePath:()=>{calls++;return root;}});
  const events=[];runtime.subscribe(event=>events.push(event));
  const execution=await runtime.execute({workspaceId:'ws',objectiveId:'o',watchId:'w',executionKey:'one'});
  assert.equal(execution.grant.granted,true);assert.equal(execution.grant.preset,'observe');assert.equal(execution.result.status,'success');assert.ok(execution.result.evidence.evidenceId);
  assert.ok(events.some(event=>event.type==='tool.started'));assert.ok(events.some(event=>event.type==='tool.completed'));
  assert.equal(execution.result.outputPreview.observation.ok,true);
  lease=false;assert.equal((await runtime.execute({workspaceId:'ws',objectiveId:'o',watchId:'w',executionKey:'two'})).result.status,'denied');
  lease=true;objective.status='paused';assert.equal((await runtime.execute({workspaceId:'ws',objectiveId:'o',watchId:'w',executionKey:'three'})).grant.granted,false);assert.equal(calls,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('probe reservations persist across restart, enforce daily and rolling hourly caps, and freeze evidence',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'watch-budget-'));let now='2026-10-01T09:00:00.000Z';
 try{
  let state=createWatchState({rootDir:root,now:()=>now});assert.equal(state.reserve('ws','o','one',1).ok,true);
  state=createWatchState({rootDir:root,now:()=>now});assert.equal(state.reserve('ws','o','two',1).reason,'daily_probe_budget');
  assert.equal(state.reserve('ws','o','one',1).ok,true);state.complete('ws','one');assert.equal(state.reserve('ws','o','one',1).replayed,true);
  const ref=state.writeEvidence('ws','one',{observation:{summary:'actual'}});state.writeEvidence('ws','one',{observation:{summary:'overwrite'}});assert.equal(state.readEvidence(ref).observation.summary,'actual');
  for(let i=1;i<60;i++)assert.equal(state.reserve('ws',`other-${i}`,`key-${i}`,1).ok,true);
  assert.equal(state.reserve('ws','more','over-hour',10).reason,'hourly_probe_budget');
  now='2026-10-01T10:00:00.001Z';assert.equal(state.reserve('ws','more','over-hour',10).ok,true);
  writeFileSync(path.join(root,'ws/objectives/watch-state.json'),JSON.stringify({schemaVersion:1,watches:{},reservations:{corrupt:{}}}));
  assert.throws(()=>createWatchState({rootDir:root}).reserve('ws','o','bad',1),/watch_state_corrupt/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
