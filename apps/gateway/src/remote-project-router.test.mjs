import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRemoteProjectRouter} from './remote-project-router.mjs';
const grant=()=>({version:1,expiresAt:60_000,workspaceIds:['bot'],allowProjectRead:true,allowProjectMessage:true,
  projectGrants:[{workspaceId:'bot',allowProjectRead:true,allowProjectMessage:true}]});
function fixture(t,options={}){let route={handle:{epoch:1},bindingVersion:2,delegation:grant(),send:message=>sent.push(message)};
  const sent=[],router=createRemoteProjectRouter({connections:{route:(owner,device)=>{if(owner!=='owner'||device!=='device')throw Error('DEVICE_UNAVAILABLE');if(!route)throw Error('DEVICE_OFFLINE');return route;}},now:()=>1000,...options});
  t.after(()=>router.close());return {router,sent,get:()=>route,set:value=>{route=value;},input:(text='hello')=>router.submit({ownerId:'owner',deviceId:'device',operation:'project.input.submit',workspaceId:'bot',requestId:'stable-input',text}),
    settle:message=>router.settle(route.handle,{type:'remote.project.result',protocolVersion:1,requestId:message.request.requestId,correlationId:message.correlationId,status:'ok',result:{status:'received',inputId:'local'}})};}
test('same stable ID has independent correlations and each answer matches its authenticated connection',async t=>{
  const f=fixture(t),first=f.input(),second=f.input();assert.equal(f.sent.length,2);assert.notEqual(f.sent[0].correlationId,f.sent[1].correlationId);
  assert.equal(f.sent[0].request.requestId,f.sent[1].request.requestId);assert.equal(f.router.settle({epoch:1},{...f.sent[0],requestId:'stable-input',status:'ok'}),false);
  assert.equal(f.router.settle(f.get().handle,{correlationId:f.sent[0].correlationId,requestId:'different',status:'ok'}),false);
  f.settle(f.sent[1]);f.settle(f.sent[0]);assert.deepEqual(await first,await second);assert.equal(f.router.pendingCount(),0);
});
test('timeout is unknown; a late response cannot settle a retry of the same stable input',async t=>{
  const f=fixture(t,{answerTimeoutMs:15}),first=f.input();await assert.rejects(first,/OUTCOME_UNKNOWN/);const retry=f.input();
  assert.equal(f.settle(f.sent[0]),false);assert.equal(f.router.pendingCount(),1);assert.equal(f.settle(f.sent[1]),true);await retry;
});
test('reconnect or grant change after submission cannot export an old successful input receipt',async t=>{
  const f=fixture(t),first=f.input(),handle=f.get().handle;f.set({...f.get(),handle:{epoch:2}});
  const message=f.sent[0];f.router.settle(handle,{requestId:'stable-input',correlationId:message.correlationId,status:'ok',result:{}});
  await assert.rejects(first,/OUTCOME_UNKNOWN/);
  const second=f.input();f.get().delegation.version++;f.settle(f.sent[1]);await assert.rejects(second,/OUTCOME_UNKNOWN/);
});
test('offline, unauthorized bots, disabled message capability and malformed fields never dispatch',async t=>{
  const f=fixture(t);
  await assert.rejects(f.router.submit({ownerId:'other',deviceId:'device',operation:'project.list'}),/DEVICE_UNAVAILABLE/);
  await assert.rejects(f.input('x'.repeat(4001)),/INPUT_TOO_LONG/);
  f.get().delegation.projectGrants[0].allowProjectMessage=false;await assert.rejects(f.input(),/MESSAGE_DENIED/);
  f.get().delegation.allowProjectRead=false;await assert.rejects(f.input(),/PROJECT_DENIED/);
  f.set(null);await assert.rejects(f.input(),/DEVICE_OFFLINE/);assert.equal(f.sent.length,0);
});
test('transport throws and close never assert a queued input failed',async t=>{
  const f=fixture(t);f.get().send=()=>{throw Error('internal private path');};await assert.rejects(f.input(),/OUTCOME_UNKNOWN/);
  f.get().send=message=>f.sent.push(message);const pending=f.input();f.router.close();await assert.rejects(pending,/OUTCOME_UNKNOWN/);
});
