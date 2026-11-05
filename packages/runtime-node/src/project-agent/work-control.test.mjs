import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createWorkCoordinationStore} from './work-coordination-store.mjs';
import {registerWorkBudget,createWorkBudgetGuard} from './work-budget.mjs';
import {controlProjectWork} from './work-control.mjs';
import { runtimeWorkHeld } from './runtime-disposition.ts';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { hostWakeWait } from './wake-wait.mjs';
import { reconcileRepairCustody } from './repair-custody.mjs';
test('scope controls gate admission first, preserve unrelated and terminal work, retry only unfinished targets',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'r88-control-'));
 const store=createWorkCoordinationStore({rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'test-owner'});
 store.saveWork({workId:'work',parentConversationId:'c',state:'waiting_children'});
 const release=registerWorkBudget('w',store);let fail=true, stopUnconfirmed=true;const called=[];
 const rows=[{sessionId:'a',status:'running',origin:{workId:'work'}},{sessionId:'b',status:'running',origin:{workId:'work'}},{sessionId:'accepted',status:'accepted',origin:{workId:'work'}},{sessionId:'other',status:'running',origin:{workId:'other'}}];
 const ports={session:rows[0],context:{workspaceId:'w',parentConversationId:'c'},sessions:()=>rows,
  pause:async id=>{called.push('pause:'+id);if(id==='b'&&stopUnconfirmed){stopUnconfirmed=false;return{error:'execution_outcome_unknown'};}return{ok:true};},cancel:async id=>{called.push('cancel:'+id);if(id==='b'&&fail){fail=false;return{error:'temporary'};}const row=rows.find(item=>item.sessionId===id);row.status='cancelled';row.origin.cancellation={phase:'completed'};return{ok:true};},resume:async id=>{called.push('resume:'+id);return{ok:true};}};
 try{
  assert.equal((await controlProjectWork({...ports,action:'pause',anchorMessageId:'pause'})).error,'execution_outcome_unknown');
  assert.equal((await controlProjectWork({...ports,action:'resume',anchorMessageId:'too-soon'})).error,'work_control_pending');
  assert.deepEqual(store.readWork('work').pendingControl.completedSessionIds,['a']);
  assert.equal(called.some(call=>call.startsWith('resume:')),false);
  assert.equal((await controlProjectWork({...ports,action:'pause',anchorMessageId:'pause'})).ok,true);
  assert.throws(()=>createWorkBudgetGuard({workspaceId:'w',workId:'work'}).beforeTool(),/stopped/);
  assert.equal((await controlProjectWork({...ports,action:'resume',anchorMessageId:'resume'})).ok,true);
  assert.equal(store.read().works.work.state,'waiting_children');
  assert.equal((await controlProjectWork({...ports,action:'cancel',anchorMessageId:'cancel'})).error,'temporary');
  assert.equal(store.read().works.work.state,'cancelled');
  assert.equal((await controlProjectWork({...ports,action:'cancel',anchorMessageId:'cancel'})).ok,true);
  assert.equal((await controlProjectWork({...ports,action:'cancel',anchorMessageId:'cancel'})).replayed,true);
  assert.equal(called.filter(x=>x==='cancel:a').length,1);assert.equal(called.filter(x=>x==='cancel:b').length,2);
  assert.equal(called.some(x=>/other|accepted/.test(x)),false);
  assert.equal((await controlProjectWork({...ports,action:'resume',anchorMessageId:'later'})).error,'work_already_ended');
 }finally{release();rmSync(root,{recursive:true,force:true});}
});

test('user cancellation repairs delivered or previously cancelled work and retries only unknown outcomes', async () => {
 for(const initialState of ['delivered','cancelled']){
 const root=mkdtempSync(path.join(os.tmpdir(),'result-control-'));
 const store=createWorkCoordinationStore({rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'owner'});
 store.saveWork({workId:'work',parentConversationId:'c',state:initialState,
  ...(initialState==='cancelled'?{lastControl:{receiptKey:'cancel:stop',action:'cancel',anchorMessageId:'stop'}}:{})});
 const release=registerWorkBudget('w',store), called=[];
 const rows=['result_ready','failed','cancelled','accepted'].map(status=>({sessionId:status,status,origin:{workId:'work'}}));
 rows.push({sessionId:'other',status:'result_ready',origin:{workId:'other'}});
 let unknown=true;
 const ports={session:rows[0],context:{workspaceId:'w',parentConversationId:'c'},sessions:()=>rows,
  cancel:async id=>{
   assert.equal(store.read().works.work.stopScope,'work');
   assert.throws(()=>createWorkBudgetGuard({workspaceId:'w',workId:'work'}).beforeTool(),/stopped/);
   called.push(id);
   if(id==='failed'&&unknown){unknown=false;return{error:'execution_outcome_unknown'};}
   const row=rows.find(item=>item.sessionId===id);row.status='cancelled';row.origin.cancellation={phase:'completed'};
   return{status:'cancelled'};
  }};
 try{
  assert.equal((await controlProjectWork({...ports,action:'pause',anchorMessageId:'pause'})).error,'work_already_ended');
  assert.equal((await controlProjectWork({...ports,action:'cancel',anchorMessageId:'stop'})).error,'execution_outcome_unknown');
  assert.deepEqual(store.read().works.work.pendingControl.completedSessionIds,['result_ready']);
  assert.equal((await controlProjectWork({...ports,action:'cancel',anchorMessageId:'stop'})).ok,true);
  assert.equal((await controlProjectWork({...ports,action:'cancel',anchorMessageId:'stop'})).replayed,true);
  assert.deepEqual(called,['result_ready','failed','failed','cancelled']);
  assert.equal(store.read().works.work.pendingControl,null);
  assert.equal(rows.find(row=>row.sessionId==='accepted').status,'accepted');
  assert.equal(rows.find(row=>row.sessionId==='other').status,'result_ready');
 }finally{release();rmSync(root,{recursive:true,force:true});}
 }
});

test('explicit work resume clears current admission even when an earlier finish retained a user-stopped end marker', async () => {
 const root=mkdtempSync(path.join(os.tmpdir(),'work-resume-marker-'));
 const store=createWorkCoordinationStore({rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'owner'});
 store.saveWork({workId:'work',workspaceId:'w',parentConversationId:'c',state:'paused',stopScope:'work',end:'user_stopped',sessionIds:['child']});
 const release=registerWorkBudget('w',store);
 const child={sessionId:'child',status:'paused',origin:{workId:'work'}};
 try{
  assert.equal(runtimeWorkHeld(store.readWork('work')),true);
  assert.equal((await controlProjectWork({session:child,action:'resume',anchorMessageId:'resume',context:{workspaceId:'w',parentConversationId:'c'},
   sessions:()=>[child],resume:async()=>{child.status='running';return{ok:true};}})).ok,true);
  const current=store.readWork('work');
  assert.equal(current.state,'waiting_children'); assert.equal(current.lastControl.action,'resume');
  assert.equal(current.end,'awaiting_children');
  assert.equal(runtimeWorkHeld(current),false);
  assert.equal(current.stopScope,'reply');
  assert.deepEqual(hostWakeWait({kind:'wake',events:[{kind:'session_running',sessionId:'child'}]},store.readWork('work'),[child]),
   {sessionIds:['child'],source:'host'},'resumed work must retain deterministic waiting without model polling');
  const coordination=createRunnerCoordination({store,workspaceId:'w',conversationId:'c',inbox:{},resolveRoster:()=>[child],readMessages:()=>[]});
  assert.equal(coordination.prepare({workId:'work',continuation:true}),true,'the explicit work control must reopen parent admission');
  const checkpointRef=store.checkpoint('work',{outcome:{rounds:[]}});
  store.saveWork({...current,state:'delivered',checkpointRef}); child.status='result_ready';
  reconcileRepairCustody({store,conversationId:'c',sessions:[child]});
  assert.equal(store.readWork('work').state,'runnable','resumed work retains its owned technical follow-up after reply settlement');
  for(const state of ['waiting_children','runnable','delivered']){
   for(const lastControl of [undefined,{action:'cancel'},{action:'pause'},current.lastControl]){
    store.saveWork({...current,state,stopScope:'work',end:'user_stopped',lastControl});
    assert.equal(runtimeWorkHeld(store.readWork('work')),true,'a historical resume cannot clear a later or ambiguous stop');
    assert.equal(coordination.prepare({workId:'work',continuation:true}),false);
    assert.equal(coordination.prepare({workId:'work',continuation:true,manualRecovery:true}),false);
   }
  }
 }finally{release();store.close();rmSync(root,{recursive:true,force:true});}
});

test('a later work pause settles after an in-flight resume and keeps the final gate closed', async () => {
 const root = mkdtempSync(path.join(os.tmpdir(), 'work-control-overlap-'));
 const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner' });
 const release = registerWorkBudget('w', store);
 const child = { sessionId: 'child', status: 'paused', origin: { workId: 'work' } };
 const context = { workspaceId: 'w', parentConversationId: 'c' };
 const { promise: started, resolve: begin } = Promise.withResolvers();
 const { promise: blocked, resolve: finish } = Promise.withResolvers();
 const commands = { session: child, context, sessions: () => [child],
  resume: async () => { begin(); await blocked; child.status = 'running'; return { ok: true }; },
  pause: async () => { child.status = 'paused'; return { ok: true }; } };
 try {
  store.saveWork({ workId: 'work', parentConversationId: 'c', state: 'paused', stopScope: 'work', end: 'user_stopped' });
  const resuming = controlProjectWork({ ...commands, action: 'resume', anchorMessageId: 'resume' });
  await started;
  assert.equal(runtimeWorkHeld(store.readWork('work')), true, 'pending resume cannot admit the parent');
  const pausing = controlProjectWork({ ...commands, action: 'pause', anchorMessageId: 'pause' });
  await new Promise(resolve => setImmediate(resolve));
  finish();
  const settled = await Promise.allSettled([resuming, pausing]);
  assert.ok(settled.every(row => row.status === 'fulfilled' && row.value.ok), JSON.stringify(settled));
  assert.equal(child.status, 'paused');
  const work = store.readWork('work');
  assert.equal(work.state, 'paused');
  assert.equal(work.lastControl.action, 'pause');
  assert.equal(runtimeWorkHeld(work), true);
 } finally { finish(); release(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
