import assert from 'node:assert/strict';
import {test} from 'node:test';
import {admitRemoteProject,parseRemoteProjectRequest,type RemoteProjectContext,type RemoteProjectRequest} from './remote-access.ts';

const base={protocolVersion:1 as const,type:'project.submit' as const,requestId:'request',ownerId:'owner',deviceId:'device',bindingVersion:1,connectionEpoch:2,delegationVersion:3,expiresAt:20_000};
const requests:RemoteProjectRequest[]=[
  {...base,operation:'project.list'},
  {...base,operation:'project.conversation.read',workspaceId:'workspace',limit:50,before:null},
  {...base,operation:'project.session.read',workspaceId:'workspace',sessionId:'session'},
  {...base,operation:'project.input.submit',workspaceId:'workspace',text:'hello'},
];
function context():RemoteProjectContext {
  return {now:10_000,ownerId:'owner',deviceId:'device',bindingVersion:1,connectionEpoch:2,online:true,bindingRevoked:false,
    delegation:{version:3,expiresAt:60_000,revoked:false,workspaceIds:['workspace','other'],allowProjectRead:true,allowProjectMessage:true,
      projectGrants:[{workspaceId:'workspace',allowProjectRead:true,allowProjectMessage:true},{workspaceId:'other',allowProjectRead:false,allowProjectMessage:false}]},
    project:{workspaceId:'workspace',status:'active'},session:{workspaceId:'workspace',sessionId:'session'}};
}
for(const request of requests) {
  test(`${request.operation}: strict shape and scalar snapshots`,()=>{
    const input={...request};const parsed=parseRemoteProjectRequest(input);assert.deepEqual(parsed,{ok:true,request});
    input.ownerId='mutated';assert.equal(parsed.ok&&parsed.request.ownerId,'owner');
    for(const value of [null,[],{}, {...request,protocolVersion:2},{...request,attachments:[]},{...request,path:'/private'},
      {...request,bindingVersion:NaN},{...request,ownerId:''},{...request,operation:'permission.approve'}]) assert.equal(parseRemoteProjectRequest(value).ok,false);
    for(const key of Object.keys(request)){const missing={...request} as Record<string,unknown>;delete missing[key];assert.equal(parseRemoteProjectRequest(missing).ok,false);}
  });
  for(const [name,patch,code] of [
    ['bound',{},null],['owner',{ownerId:'foreign'},'IDENTITY_UNBOUND'],['device',{deviceId:'foreign'},'IDENTITY_UNBOUND'],
    ['binding',{bindingVersion:2},'IDENTITY_UNBOUND'],['revoked-binding',{bindingRevoked:true},'IDENTITY_UNBOUND'],
    ['offline',{online:false},'DEVICE_OFFLINE'],['epoch',{connectionEpoch:3},'STALE_CONNECTION'],['expired-request',{now:20_000},'REQUEST_EXPIRED'],
    ['invalid-clock',{now:NaN},'DELEGATION_EXPIRED'],
  ] as const) test(`${request.operation}: ${name}`,()=>{
    const result=admitRemoteProject(request,{...context(),...patch});assert.deepEqual(result,code?{ok:false,code}:{ok:true,request});
  });
  test(`${request.operation}: delegation expiry, revocation and version are checked`,()=>{
    for(const patch of [{revoked:true},{version:4},{expiresAt:10_000},{expiresAt:NaN}]) {
      const c=context();assert.deepEqual(admitRemoteProject(request,{...c,delegation:{...c.delegation,...patch}}),{ok:false,code:'DELEGATION_EXPIRED'});
    }
    const c=context();assert.deepEqual(admitRemoteProject(request,{...c,delegation:{...c.delegation,allowProjectRead:false}}),{ok:false,code:'PROJECT_DENIED'});
    assert.deepEqual(admitRemoteProject({...request,expiresAt:40_001},c),{ok:false,code:'REQUEST_EXPIRED'});
  });
  if(request.operation!=='project.list') test(`${request.operation}: each bot has its own grant`,()=>{
    const c=context();assert.deepEqual(admitRemoteProject({...request,workspaceId:'missing'},c),{ok:false,code:'WORKSPACE_DENIED'});
    assert.deepEqual(admitRemoteProject({...request,workspaceId:'other'},{...c,project:{workspaceId:'other',status:'active'}}),{ok:false,code:'PROJECT_DENIED'});
    for(const project of [null,{workspaceId:'workspace',status:'archived'},{workspaceId:'foreign',status:'active'}]) {
      assert.deepEqual(admitRemoteProject(request,{...c,project}),{ok:false,code:'PROJECT_DENIED'});
    }
  });
}
test('message permission does not follow another bot or the global bit alone',()=>{
  const r=requests[3]!,c=context();
  for(const delegation of [{...c.delegation,allowProjectMessage:false},{...c.delegation,projectGrants:[{workspaceId:'workspace',allowProjectRead:true,allowProjectMessage:false}]}]) {
    assert.deepEqual(admitRemoteProject(r,{...c,delegation}),{ok:false,code:'MESSAGE_DENIED'});
  }
});
test('session resource is resolved from local ownership',()=>{
  const c=context();for(const session of [null,{workspaceId:'other',sessionId:'session'},{workspaceId:'workspace',sessionId:'other'}]) {
    assert.deepEqual(admitRemoteProject(requests[2],{...c,session}),{ok:false,code:'TASK_DENIED'});
  }
});
test('input limit counts Unicode characters and only accepts text',()=>{
  const r=requests[3]!;
  assert.equal(parseRemoteProjectRequest({...r,text:'😀'.repeat(4000)}).ok,true);
  assert.deepEqual(parseRemoteProjectRequest({...r,text:'中'.repeat(4001)}),{ok:false,code:'INPUT_TOO_LONG'});
  for(const text of ['', '  ',42,'hello\0world','\x1b[31m'])assert.equal(parseRemoteProjectRequest({...r,text}).ok,false);
  assert.equal(parseRemoteProjectRequest({...r,text:'first\nsecond\tline'}).ok,true);
});
test('conversation page limit and cursor are bounded',()=>{
  const r=requests[1]!;for(const patch of [{limit:0},{limit:51},{limit:1.5},{before:'/path'},{before:'x'.repeat(257)}]) assert.equal(parseRemoteProjectRequest({...r,...patch}).ok,false);
  assert.equal(parseRemoteProjectRequest({...r,before:'input-'+ 'x'.repeat(128)}).ok,true);
});
