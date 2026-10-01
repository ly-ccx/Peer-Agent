import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createConversationStore} from '@peer-agent/conversation-store';
import {createBotDirectory,createBotLifecycle,createInputQueue,createProjectRegistry,createRemoteReceiptStore} from '@peer-agent/runtime-node';
import {createRemoteProjectAccess} from './remote-project-access.mjs';

function fixture(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),'peer-project-access-')),folder=path.join(root,'project');mkdirSync(folder);
  const registry=createProjectRegistry({filePath:path.join(root,'projects/registry.json')}),entry=registry.ensureForPath(folder);
  const conversations=createConversationStore({storeDir:path.join(root,'conversations')}),life=createBotLifecycle({rootDir:root,registry,conversationStore:conversations});
  const profile=life.ensureBot(entry.workspaceId).profile,workspaceId=entry.workspaceId;
  const sessions=[{sessionId:'task',workspaceId,title:'inspect',status:'running',updatedAt:'2026-10-01T00:00:00.000Z',
    report:{summary:`Read ${folder}/secret; C:\\Users\\private\\key`,evidenceRefs:['raw-evidence'],changedFiles:[{path:folder}],toolResults:'private'}}];
  const directory=createBotDirectory({rootDir:root,registry,readMessages:id=>conversations.getPersistedConversationHistory(id)?.messages??[],
    listSessions:id=>sessions.filter(row=>row.workspaceId===id),getSession:id=>sessions.find(row=>row.sessionId===id),
    listApprovals:()=>[{state:'open',summary:`write ${folder}/secret`,argsDigest:'private',toolCallId:'private',arguments:{apiKey:'private'}}]});
  const queueRoot=path.join(root,'project-runtime');
  const inputQueue=createInputQueue({rootDir:queueRoot,now:()=> '2026-10-01T00:00:00.000Z'}),receipts=createRemoteReceiptStore(path.join(root,'receipts.sqlite'));
  const delegation={version:1,expiresAt:60_000,revoked:false,workspaceIds:[workspaceId],allowProjectRead:true,allowProjectMessage:true,
    projectGrants:[{workspaceId,allowProjectRead:true,allowProjectMessage:true}]};
  const identity={now:10_000,ownerId:'owner',deviceId:'device',bindingVersion:1,connectionEpoch:2,online:true,bindingRevoked:false};
  const ports={directory,inputQueue,getSession:id=>sessions.find(row=>row.sessionId===id),wake:()=>{}};
  const accesses=[];let lookups=0;
  const resolveLocal=request=>{lookups++;const got='workspaceId' in request?directory.get(request.workspaceId):null,session=ports.getSession(request.sessionId);
    return {projectAccess:ports,privatePaths:[folder],sessionFacts:session,admission:{...identity,delegation,
      project:got?.ok?{workspaceId:got.profile.workspaceId,status:got.profile.status}:null,
      session:session?{sessionId:session.sessionId,workspaceId:session.workspaceId}:null}};};
  const access=createRemoteProjectAccess({resolveLocal,receipts,onAccess:row=>accesses.push(row)});
  const request=(operation,extra={})=>({protocolVersion:1,type:'project.submit',requestId:'request',ownerId:'owner',deviceId:'device',bindingVersion:1,
    connectionEpoch:2,delegationVersion:delegation.version,expiresAt:20_000,operation,...(operation!=='project.list'?{workspaceId}:{}),...extra});
  const queue=()=>{try{return readFileSync(path.join(queueRoot,workspaceId,'input-queue.jsonl'),'utf8').trim().split('\n').map(JSON.parse);}catch{return[];}};
  t.after(()=>{receipts.close();rmSync(root,{recursive:true,force:true});});
  return {root,folder,registry,conversations,profile,workspaceId,sessions,directory,inputQueue,receipts,delegation,identity,ports,access,request,queue,accesses,lookups:()=>lookups};
}

test('strict wire errors never resolve local state, enqueue input or leak thrown paths',async t=>{
  const f=fixture(t);
  for(const patch of [{operation:'permission.approve'},{attachments:[]},{text:'x',operation:'project.list'},{protocolVersion:99}]) {
    assert.equal((await f.access({...f.request('project.list'),...patch})).ok,false);
  }
  assert.equal(f.lookups(),0);assert.deepEqual(f.queue(),[]);
  const broken=createRemoteProjectAccess({receipts:f.receipts,resolveLocal:()=>{throw new Error('/private/vault/API_KEY');}});
  assert.deepEqual(await broken(f.request('project.list')),{ok:false,code:'LOCAL_STATE_UNAVAILABLE'});
});

test('only active authorized bots are listed; profile fields and local image paths are withheld',async t=>{
  const f=fixture(t),second=path.join(f.root,'other');mkdirSync(second);const entry=f.registry.ensureForPath(second);
  createBotLifecycle({rootDir:f.root,registry:f.registry,conversationStore:f.conversations}).ensureBot(entry.workspaceId);
  const answer=await f.access(f.request('project.list'));assert.equal(answer.ok,true);assert.equal(answer.result.projects.length,1);
  const row=answer.result.projects[0];assert.equal(row.workspaceId,f.workspaceId);assert.equal(row.canMessage,true);
  assert.deepEqual(Object.keys(row).sort(),['avatar','canMessage','lastActiveAt','name','preview','state','workspaceId']);
  assert.equal(JSON.stringify(answer).includes(f.root),false);assert.equal(f.accesses[0].operation,'project.list');
});

test('conversation pages use shared latest cursors and expose only bounded factual fields',async t=>{
  const f=fixture(t);
  for(let index=0;index<120;index++)f.conversations.appendMessage(f.profile.agentConversationId,{id:`message-${index}`,role:'assistant',kind:'agent_reply',content:`reply ${index}`});
  f.conversations.appendMessage(f.profile.agentConversationId,{id:'tool-private',role:'tool',kind:'tool_result',content:'raw-private-tool-result'});
  const first=await f.access(f.request('project.conversation.read',{limit:50,before:null}));assert.equal(first.ok,true);
  assert.equal(first.result.messages.length,50);assert.equal(first.result.messages[0].id,'message-70');assert.equal(first.result.messages.at(-1).id,'message-119');
  const older=await f.access(f.request('project.conversation.read',{limit:50,before:first.result.nextCursor}));assert.equal(older.result.messages[0].id,'message-20');assert.equal(older.result.messages.at(-1).id,'message-69');
  assert.equal(JSON.stringify(first).includes('raw-private-tool-result'),false);
  assert.deepEqual(first.result.pendingApprovals,[{state:'open',summary:'write [local path]/secret',needsDesktopApproval:true}]);
  assert.equal(first.result.sessions[0].sessionId,'task');assert.equal(JSON.stringify(first).includes('argsDigest'),false);
});

test('messages and task reports redact local paths, Evidence and approval actions',async t=>{
  const f=fixture(t);
  f.conversations.appendMessage(f.profile.agentConversationId,{id:'message',role:'assistant',kind:'system_card',content:`file ${f.folder} ${'😀'.repeat(4100)}`,
    cards:[{cardId:'approval',kind:'approval',content:`approve ${f.folder}`,actions:[{channel:'permission.approve',payload:{apiKey:'private'}}]}],
    meta:{sources:['task']},toolResult:{secret:'private'},evidence:{body:'raw-evidence'},attachmentRefs:[f.folder]});
  const answer=await f.access(f.request('project.conversation.read',{limit:50,before:null}));
  assert.equal(answer.result.messages[0].needsDesktopApproval,true);assert.equal(Array.from(answer.result.messages[0].content).length,4000);
  assert.deepEqual(answer.result.messages[0].sourceSessionIds,['task']);
  const task=await f.access(f.request('project.session.read',{sessionId:'task'}));assert.equal(task.ok,true);
  const output=JSON.stringify([answer,task]);for(const forbidden of [f.folder,'C:\\Users','raw-evidence','changedFiles','toolResult','attachmentRefs','apiKey','permission.approve'])assert.equal(output.includes(forbidden),false,forbidden);
  f.sessions[0].workspaceId='other';assert.deepEqual(await f.access(f.request('project.session.read',{sessionId:'task'})),{ok:false,code:'TASK_DENIED'});
});

test('same input receipt survives retry and re-admission without repeating queue writes',async t=>{
  const f=fixture(t),r=f.request('project.input.submit',{text:' hello '});
  const first=await f.access(r);assert.equal(first.ok,true);assert.equal(first.result.status,'received');
  f.identity.connectionEpoch=3;f.delegation.version=2;
  const retry={...r,connectionEpoch:3,delegationVersion:2,expiresAt:30_000,text:'hello'};
  assert.deepEqual(await f.access(retry),first);assert.equal(f.queue().length,1);assert.equal(f.queue()[0].surface,'remote');assert.equal(f.queue()[0].text,'hello');
  assert.deepEqual(await f.access({...retry,text:'different'}),{ok:false,code:'REQUEST_CONFLICT'});
  f.delegation.projectGrants[0].allowProjectMessage=false;
  assert.deepEqual(await f.access(retry),{ok:false,code:'MESSAGE_DENIED'},'receipt lookup still requires current authorization');
  assert.equal(f.queue().length,1);
});

test('queue write / lost receipt crash window returns the original acknowledgment on retry',async t=>{
  const f=fixture(t),remember=f.receipts.rememberProject;
  f.receipts.rememberProject=()=>{throw new Error('simulated disk interruption');};
  const r=f.request('project.input.submit',{text:'once'});assert.deepEqual(await f.access(r),{ok:false,code:'OUTCOME_UNKNOWN'});assert.equal(f.queue().length,1);
  f.receipts.rememberProject=remember;
  const retry=await f.access(r);assert.equal(retry.ok,true);assert.equal(retry.result.createdAt,f.queue()[0].createdAt);assert.equal(f.queue().length,1);
});

test('authorization is checked after asynchronous reads and before exporting receipts',async t=>{
  const f=fixture(t),read=f.directory.readConversation;
  f.directory.readConversation=async(...args)=>{const result=read(...args);f.delegation.revoked=true;return result;};
  assert.deepEqual(await f.access(f.request('project.conversation.read',{limit:50,before:null})),{ok:false,code:'DELEGATION_EXPIRED'});
  f.delegation.revoked=false;
  const submit=f.inputQueue.submitInput;
  f.inputQueue.submitInput=input=>{const result=submit(input);f.identity.online=false;return result;};
  assert.deepEqual(await f.access(f.request('project.input.submit',{text:'authorized at enqueue'})),{ok:false,code:'OUTCOME_UNKNOWN'});
  assert.equal(f.queue().length,1);
});

test('same-version local edits cannot export a bot whose read grant was withdrawn',async t=>{
  const f=fixture(t),list=f.directory.list;
  f.directory.list=async()=>{const rows=list();f.delegation.projectGrants[0].allowProjectRead=false;return rows;};
  const answer=await f.access(f.request('project.list'));assert.equal(answer.ok,true);assert.deepEqual(answer.result.projects,[]);
});
