import assert from 'node:assert/strict';
import {test} from 'node:test';
import {connectRemoteDevice} from './remote-device-connection.mjs';
import {REMOTE_PROJECT_LIMITS} from '@peer-agent/protocol';

const origin='https://peer.example',binding={origin,deviceId:'device',ownerId:'owner',bindingVersion:1,disabled:false};
const grant=()=>({version:1,workspaceIds:['workspace'],allowTaskRead:true,allowResultExport:true,expiresAt:60_000,
  allowProjectRead:true,allowProjectMessage:true,projectGrants:[{workspaceId:'workspace',allowProjectRead:true,allowProjectMessage:true}]});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,options={}) {
  const socket=new EventTarget(),sent=[];socket.readyState=1;socket.send=value=>sent.push(JSON.parse(value));socket.close=()=>{socket.readyState=3;};
  const client=connectRemoteDevice({origin,store:{load:()=>binding},sign:async()=> 'local-signature',now:()=>1000,delegation:grant(),socketFactory:()=>socket,...options});
  t.after(()=>client.stop());
  const receive=async value=>{const event=new Event('message');event.data=JSON.stringify(value);socket.dispatchEvent(event);await flush();};
  async function online() {
    socket.dispatchEvent(new Event('open'));const nonce='a'.repeat(43);
    await receive({type:'remote.challenge',nonce,expiresAt:60_000,message:JSON.stringify(['peer-device-proof-v1',origin,'connection',nonce,60_000])});
    await receive({type:'remote.welcome',protocolVersion:1,connectionEpoch:2,deviceId:'device',ownerId:'owner',bindingVersion:1});
    assert.equal(sent.at(-1).type,'remote.delegation');
  }
  return {socket,sent,client,receive,online};
}
const request=text=>({type:'remote.project.request',protocolVersion:1,correlationId:'relay-1',request:{protocolVersion:1,type:'project.submit',requestId:'request',ownerId:'owner',deviceId:'device',
  bindingVersion:1,connectionEpoch:2,delegationVersion:1,expiresAt:20_000,operation:'project.input.submit',workspaceId:'workspace',text}});

test('4000 Chinese characters reach only the project adapter and large Unicode pages remain intact',async t=>{
  let projects=0,tasks=0;
  const f=fixture(t,{onTaskRead:async()=>{tasks++;},onProjectAccess:async r=>{projects++;assert.equal(r.text.length,4000);
    return {status:'ok',result:{messages:Array.from({length:50},()=>({content:'😀'.repeat(4000)}))}};}});
  await f.online();await f.receive(request('中'.repeat(4000)));
  const answer=f.sent.at(-1);assert.equal(answer.type,'remote.project.result');assert.equal(answer.status,'ok');
  assert.equal(answer.correlationId,'relay-1');
  assert.equal(answer.result.messages.length,50);assert.equal(Array.from(answer.result.messages[49].content).length,4000);
  assert.ok(Buffer.byteLength(JSON.stringify(answer))>4096);assert.ok(Buffer.byteLength(JSON.stringify(answer))<REMOTE_PROJECT_LIMITS.resultBytes);
  assert.equal(projects,1);assert.equal(tasks,0);
});

test('project result over the configured budget is refused without truncation',async t=>{
  const f=fixture(t,{onProjectAccess:async()=>({status:'ok',result:{blob:'x'.repeat(REMOTE_PROJECT_LIMITS.resultBytes)}})});
  await f.online();await f.receive(request('hello'));
  assert.deepEqual(f.sent.at(-1),{type:'remote.project.result',protocolVersion:1,requestId:'request',correlationId:'relay-1',status:'failed',code:'RESULT_TOO_LARGE'});
});

test('legacy and pre-auth frames retain 4KiB admission and do not reach project handlers',async t=>{
  let calls=0;const f=fixture(t,{onTaskRead:async()=>{calls++;}});await f.online();
  const value=request('中'.repeat(4000));value.type='remote.task.request';await f.receive(value);
  assert.equal((await f.client.closed).reason,'protocol_failure');assert.equal(calls,0);
  const before=fixture(t);await before.receive({type:'remote.challenge',blob:'x'.repeat(5000)});
  assert.equal((await before.client.closed).reason,'protocol_failure');
});

test('project request over 32KiB is refused before parsing or dispatch',async t=>{
  let calls=0;const f=fixture(t,{onProjectAccess:async()=>{calls++;}});await f.online();await f.receive(request('x'.repeat(REMOTE_PROJECT_LIMITS.requestBytes)));
  assert.equal((await f.client.closed).reason,'invalid_frame');assert.equal(calls,0);
});

test('extended delegation is bounded, explicit, and defaults all project capabilities off',async t=>{
  let sockets=0;
  for(const delegation of [
    {...grant(),allowProjectMessage:false},{...grant(),projectGrants:[{workspaceId:'workspace',allowProjectRead:false,allowProjectMessage:true}]},
    {...grant(),projectGrants:[...grant().projectGrants,...grant().projectGrants]},
    {...grant(),workspaceIds:[]},{...grant(),approve:true},
  ])assert.throws(()=>connectRemoteDevice({origin,store:{load:()=>binding},sign:async()=>'',delegation,now:()=>1000,socketFactory:()=>{sockets++;}}),/INVALID_DELEGATION/);
  assert.equal(sockets,0);
  const off=fixture(t,{delegation:{...grant(),workspaceIds:[],allowProjectRead:false,allowProjectMessage:false,projectGrants:[]}});
  await off.online();assert.equal(off.sent.at(-1).allowProjectMessage,false);
  const projects=Array.from({length:200},(_,i)=>({workspaceId:`workspace-${i}`,allowProjectRead:true,allowProjectMessage:false}));
  const many=fixture(t,{delegation:{...grant(),workspaceIds:projects.map(row=>row.workspaceId),allowProjectMessage:false,projectGrants:projects}});
  await many.online();assert.equal(many.sent.at(-1).projectGrants.length,200);
});
