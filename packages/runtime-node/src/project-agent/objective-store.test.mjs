import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createObjectiveStore } from './objective-store.mjs';

const definition = extra => ({workspaceId:'w',projectAgentConversationId:'c',originMessageId:'input-1',title:'Keep CI green',outcome:'CI succeeds',autonomy:'propose',createdBy:'user_request',successSignals:[],milestones:[],watches:[],...extra});
test('objective definitions survive restart, are workspace scoped and keep creation idempotent',()=>{
  const rootDir=mkdtempSync(path.join(os.tmpdir(),'objective-store-'));
  try{
    const store=createObjectiveStore({rootDir});
    const a=store.create(definition(),{requestId:'create-1'});assert.equal(a.ok,true);
    assert.equal(store.create(definition({title:'same request'}),{requestId:'create-1'}).item.objectiveId,a.item.objectiveId);
    const restarted=createObjectiveStore({rootDir});assert.equal(restarted.get('w',a.item.objectiveId).title,'Keep CI green');
    assert.equal(restarted.get('other',a.item.objectiveId),null);
    assert.equal(restarted.update('other',a.item.objectiveId,{title:'escape'}).ok,false);
    assert.equal(restarted.update('w',a.item.objectiveId,{status:'paused'}).item.status,'paused');
    assert.equal(restarted.create(definition({workspaceId:'../escape'})).ok,false);
    assert.equal(restarted.create(definition({budget:{maxAutoSessionsPerDay:3,maxProbeRunsPerDay:60,maxTokensPerDay:100}})).code,'TOKEN_BUDGET_UNSUPPORTED');
  }finally{rmSync(rootDir,{recursive:true,force:true});}
});
test('observations persist every factual check and deduplicate by execution key without accepting forged changed flags',()=>{
  const rootDir=mkdtempSync(path.join(os.tmpdir(),'objective-observation-'));
  try{
    const store=createObjectiveStore({rootDir});const objective=store.create(definition({watches:[{watchId:'check',kind:'schedule',schedule:{kind:'hourly',timezone:'UTC',everyHours:1},probe:{type:'deterministic',check:'git_ref',spec:{ref:'HEAD'}}}]})).item;
    const next=extra=>({objectiveId:objective.objectiveId,watchId:'check',observedAt:'2026-10-01T00:00:00Z',digest:'a',summary:'same',evidenceRefs:['ev'],severity:'info',...extra});
    assert.equal(store.appendObservation('w',next({changed:false}),{executionKey:'one'}).item.changed,true);
    assert.equal(store.appendObservation('w',next({changed:true}),{executionKey:'two'}).item.changed,false);
    assert.equal(store.appendObservation('w',next({digest:'b'}),{executionKey:'two'}).replayed,true);
    assert.equal(store.observations('w',objective.objectiveId).length,2);
    assert.equal(createObjectiveStore({rootDir}).observations('w',objective.objectiveId).length,2);
    assert.equal(store.appendObservation('other',next(),{executionKey:'bad'}).ok,false);
  }finally{rmSync(rootDir,{recursive:true,force:true});}
});

test('command replay survives restart and cannot revert a later change; corrupt definitions fail closed',()=>{
  const rootDir=mkdtempSync(path.join(os.tmpdir(),'objective-command-'));
  try{
    const store=createObjectiveStore({rootDir}),item=store.create(definition()).item;
    assert.equal(store.update('w',item.objectiveId,{status:'paused'},{requestId:'command',fingerprint:'pause',expectedVersion:1}).ok,true);
    store.update('w',item.objectiveId,{status:'active'});
    const restarted=createObjectiveStore({rootDir});
    assert.equal(restarted.update('w',item.objectiveId,{status:'paused'},{requestId:'command',fingerprint:'pause',expectedVersion:1}).replayed,true);
    assert.equal(restarted.get('w',item.objectiveId).status,'active');
    assert.equal(restarted.update('w',item.objectiveId,{}, {requestId:'command',fingerprint:'other'}).code,'REQUEST_ID_REUSED');
    writeFileSync(path.join(rootDir,'projects/w/objectives/objectives.json'),JSON.stringify({schemaVersion:1,items:[{...item,workspaceId:'other'}]}));
    assert.throws(()=>restarted.list('w'),/CORRUPT_OBJECTIVES/);
  }finally{rmSync(rootDir,{recursive:true,force:true});}
});
