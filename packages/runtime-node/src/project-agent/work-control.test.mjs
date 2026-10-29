import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createWorkCoordinationStore} from './work-coordination-store.mjs';
import {registerWorkBudget,createWorkBudgetGuard} from './work-budget.mjs';
import {controlProjectWork} from './work-control.mjs';
test('scope controls gate admission first, preserve unrelated and terminal work, retry only unfinished targets',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'r88-control-'));
 const store=createWorkCoordinationStore({rootDir:root,workspaceId:'w',holdsLease:()=>true,leaseEpoch:()=> 'test-owner'});
 store.saveWork({workId:'work',parentConversationId:'c',state:'waiting_children'});
 const release=registerWorkBudget('w',store);let fail=true;const called=[];
 const rows=[{sessionId:'a',status:'running',origin:{workId:'work'}},{sessionId:'b',status:'running',origin:{workId:'work'}},{sessionId:'accepted',status:'accepted',origin:{workId:'work'}},{sessionId:'other',status:'running',origin:{workId:'other'}}];
 const ports={session:rows[0],context:{workspaceId:'w',parentConversationId:'c'},sessions:()=>rows,
  pause:async id=>{called.push('pause:'+id);return{ok:true};},cancel:async id=>{called.push('cancel:'+id);if(id==='b'&&fail){fail=false;return{error:'temporary'};}return{ok:true};},resume:async id=>{called.push('resume:'+id);return{ok:true};}};
 try{
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
