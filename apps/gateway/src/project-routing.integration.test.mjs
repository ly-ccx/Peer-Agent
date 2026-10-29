import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProjectRelayFixture} from './testing/project-relay-fixture.mjs';

test('real paired WebSocket and HTTP export only granted bots and safe pages; concurrent retries enqueue once', {timeout:20_000},async t=>{
  const f=await createProjectRelayFixture({scriptedReply:true});t.after(()=>f.close());
  const listed=await f.request('/api/projects');assert.equal(listed.status,200);const bots=await listed.json();assert.equal(bots.projects.length,1);
  assert.equal(bots.projects[0].deviceId,f.deviceId);assert.equal(bots.projects[0].workspaceId,f.workspaceId);
  const url='/api/projects/'+f.workspaceId,body={deviceId:f.deviceId,inputId:'same-input',text:'中'.repeat(4000)};
  const replies=await Promise.all([f.request(url+'/input',{method:'POST',body}),f.request(url+'/input',{method:'POST',body})]);
  const results=await Promise.all(replies.map(async response=>{assert.equal(response.status,200);return (await response.json()).result;}));
  assert.deepEqual(results[0],results[1]);assert.equal(results[0].status,'received');assert.equal(f.history().filter(row=>row.kind==='user_input').length,1);
  assert.equal((await f.request(url+'/input',{method:'POST',body:{...body,text:'different'}})).status,409);
  const page=await (await f.request(url+'/conversation?deviceId='+f.deviceId)).json();assert.ok(page.result.messages.some(row=>row.kind==='agent_reply'));
  assert.equal(page.result.pendingApprovals[0].needsDesktopApproval,true);
  const task=await (await f.request(url+'/sessions/task-1?deviceId='+f.deviceId)).json();assert.equal(task.result.summary,'已读取项目说明，正在核对测试结果。');
  for(const forbidden of [f.root,'private-evidence','apiKey','arguments','toolResult'])assert.equal(JSON.stringify([bots,page,task]).includes(forbidden),false,forbidden);
  f.changePolicy({delegationVersion:2,projectGrants:[]});
  assert.equal((await f.request(url+'/input',{method:'POST',body})).status,403);assert.equal(f.history().filter(row=>row.kind==='user_input').length,1);
});

test('real HTTP rejects missing login, cross-origin, extra fields, parameters and oversized bodies without enqueue',{timeout:20_000},async t=>{
  const f=await createProjectRelayFixture();t.after(()=>f.close());const url='/api/projects/'+f.workspaceId,body={deviceId:f.deviceId,inputId:'request',text:'hello'};
  for(const path of ['/api/projects',url+'/conversation?deviceId='+f.deviceId,url+'/sessions/task-1?deviceId='+f.deviceId])assert.equal((await f.request(path,{cookie:null})).status,401);
  assert.equal((await f.request(url+'/input',{method:'POST',body,cookie:null})).status,401);
  assert.equal((await f.request(url+'/input',{method:'POST',body,originHeader:'https://evil.example'})).status,403);
  for(const extra of [{ownerId:f.ownerId},{attachments:[]},{capabilityId:'local.file.write'}])assert.equal((await f.request(url+'/input',{method:'POST',body:{...body,...extra}})).status,400);
  for(const query of ['deviceId='+f.deviceId+'&deviceId='+f.deviceId,'deviceId='+f.deviceId+'&limit=999','deviceId='+f.deviceId+'&before=%2Fprivate'])assert.equal((await f.request(url+'/conversation?'+query)).status,400);
  assert.equal((await f.request(url+'/input',{method:'POST',body:{...body,text:'x'.repeat(40_000)}})).status,413);
  assert.equal(f.history().filter(row=>row.kind==='user_input').length,0);
  f.remote.stop();await new Promise(resolve=>setTimeout(resolve,20));
  const offline=await f.request(url+'/input',{method:'POST',body});assert.equal(offline.status,409);assert.equal((await offline.json()).code,'DEVICE_OFFLINE');
});
