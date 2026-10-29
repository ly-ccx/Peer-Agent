import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createObjectiveActions,objectiveActionCardId} from './objective-actions.mjs';
import {createObjectiveStore} from './objective-store.mjs';
import {createWatchProbeRuntime} from './watch-probe-provider.mjs';
import {createObjectiveService} from './objective-service.mjs';
import {projectCards} from './card-projection.mjs';
import {createDelegationProvider} from './delegation-provider.mjs';
const task=extra=>({title:'Fix CI',brief:'Fix the observed failure',anchorMessageIds:['u'],kind:'code',readOnly:false,successCriteria:[{kind:'model_review',description:'CI passes'}],...extra});
function world(autonomy='act'){
 const root=mkdtempSync(path.join(os.tmpdir(),'objective-actions-'));let clock='2026-10-01T10:00:00Z';
 const store=createObjectiveStore({rootDir:root});const item=store.create({workspaceId:'ws',projectAgentConversationId:'c',originMessageId:'u',title:'CI',outcome:'Stable CI',autonomy,createdBy:'user_request',watches:[{watchId:'w',kind:'event',source:{type:'git',ref:'HEAD',on:'new_commits'}}]}).item;
 let actions=createObjectiveActions({rootDir:root,now:()=>clock});const messages=[{id:'u',role:'user',kind:'user_input',content:'持续监控 CI，发现问题直接修'}],sessions=new Map(),evidence=new Map();
 const service=()=>createObjectiveService({store,actions,readConversation:()=>messages,resolveConversationId:()=> 'c',readSession:id=>sessions.get(id),readSessions:()=>[...sessions.values()],resolveEvidence:ref=>evidence.get(ref)});
 function event(n=1,id=item.objectiveId){const executionKey=`check:${n}`,ref=`ev:${n}`;const e={eventId:`event-${n}`,kind:'objective_signal',workspaceId:'ws',objectiveId:id,watchId:'w',executionKey};
  store.appendObservation('ws',{objectiveId:id,watchId:'w',digest:`digest${n}`,observedAt:clock,summary:'CI failed',severity:'urgent',evidenceRefs:[ref]},{executionKey});evidence.set(ref,{workspaceId:'ws',objectiveId:id,watchId:'w',executionKey,execution:{result:{status:'success'}}});return e;}
 const context=events=>({workspaceId:'ws',parentConversationId:'c',currentInputAnchors:[],objectiveWakeEvents:events});
 return {root,store,item,messages,sessions,evidence,service,event,context,get actions(){return actions;},restart(){actions=createObjectiveActions({rootDir:root,now:()=>clock});},clock:at=>{clock=at;},cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('report-only denies; propose freezes a real card; only a current affirmative answer executes its original intent',()=>{
 for(const autonomy of ['report_only','propose']){const w=world(autonomy);try{const e=w.event(),result=w.service().prepareSpawn(task({objectiveId:w.item.objectiveId}),w.context([e]));
  if(autonomy==='report_only'){assert.equal(result.error,'objective_report_only');assert.equal(w.actions.list('ws').length,0);continue;}
  assert.equal(result.error,'objective_proposal_required');const action=w.actions.pending('ws')[0],card=projectCards('ws',{objectiveProposals:[action]})[0];assert.equal(card.actions[0].payload.answerTo,objectiveActionCardId(action.actionId));assert.equal(card.actions[0].payload.text,'开始');
  w.restart();w.messages.push({id:'answer',role:'user',kind:'user_input',content:'开始',answerTo:card.cardId});
  const context={...w.context([]),currentInputAnchors:['answer']};w.service().consumeAnswers('ws',['answer']);
  const allowed=w.service().prepareSpawn(task({objectiveId:w.item.objectiveId,title:'Delete everything',brief:'Different intent'}),context);assert.equal(allowed.ok,true);assert.equal(allowed.input.title,'Fix CI');assert.deepEqual(allowed.input.anchorMessageIds,['answer']);assert.equal(w.actions.usage('ws',w.item.objectiveId),0);
  assert.equal(w.service().prepareSpawn(task(),{...context,currentInputAnchors:[]}).ok,undefined);
 }finally{w.cleanup();}}
});
test('actual successful observations, one identity, three daily reservations and restart are enforced independent of model flags',()=>{
 const w=world();try{let first;
  for(let n=1;n<=4;n++){const e=w.event(n),context=w.context([e]),result=w.service().prepareSpawn(task(),context);
   if(n<=3){assert.equal(result.ok,true);if(n===1){first=result;const repeat=w.service().prepareSpawn(task({title:'Reworded',brief:'Rephrased',priority:'high'}),context);assert.equal(repeat.objectiveActionId,result.objectiveActionId);assert.equal(repeat.input.title,'Fix CI');assert.equal(repeat.input.priority,'low');}}
   else assert.equal(result.error,'objective_proposal_required');w.restart();}
  assert.equal(w.actions.usage('ws',w.item.objectiveId),3);assert.equal(w.actions.list('ws').length,4);
  const forged={...w.event(5),executionKey:'invented'};assert.equal(w.service().prepareSpawn(task(),w.context([forged])).error,'objective_observation_unproven');
  assert.equal(w.service().prepareSpawn(task({objectiveId:'other'}),w.context([w.event(6)])).error,'objective_not_found');
  assert.equal(w.service().prepareSpawn(task({supersedes:'s'}),w.context([w.event(7)])).error,'objective_user_confirmation_required');
  w.clock('2026-10-02T00:00:01Z');assert.equal(w.actions.usage('ws',w.item.objectiveId),0);assert.equal(w.service().prepareSpawn(task(),w.context([w.event(8)])).ok,true);
  assert.ok(first.objectiveActionId);
 }finally{w.cleanup();}
});
test('stale proposals, negative answers, paused objectives and consecutive real failed tasks cannot grant automatic work',()=>{
 const w=world('propose');try{const result=w.service().prepareSpawn(task(),w.context([w.event()]));const card=objectiveActionCardId(result.actionId);
  w.messages.push({id:'no',role:'user',kind:'user_input',content:'暂不',answerTo:card});w.service().consumeAnswers('ws',['no']);assert.equal(w.actions.pending('ws').length,0);assert.equal(w.service().prepareSpawn(task(),{...w.context([]),currentInputAnchors:['no']}).error,'objective_proposal_declined');
  const next=w.service().prepareSpawn(task(),w.context([w.event(2)]));w.store.update('ws',w.item.objectiveId,{title:'Changed'});w.messages.push({id:'yes',role:'user',kind:'user_input',content:'开始',answerTo:objectiveActionCardId(next.actionId)});assert.equal(w.service().prepareSpawn(task(),{...w.context([]),currentInputAnchors:['yes']}).error,'objective_proposal_stale');
  w.store.update('ws',w.item.objectiveId,{autonomy:'act'});for(let n=1;n<=3;n++)w.sessions.set(`s${n}`,{sessionId:`s${n}`,workspaceId:'ws',status:'failed',origin:{objectiveId:w.item.objectiveId}});assert.equal(w.service().prepareSpawn(task(),w.context([w.event(3)])).error,'objective_proposal_required');
  w.store.update('ws',w.item.objectiveId,{status:'paused'});assert.equal(w.service().prepareSpawn(task(),w.context([w.event(4)])).error,'objective_paused');
 }finally{w.cleanup();}
});
test('automatic acceptance requires explicit canonical consent; missing, quoted and negative approval never grants it',()=>{
 const w=world();try{const objectiveId=w.item.objectiveId,view={workspaceId:'ws',conversationId:'c',currentInputAnchors:['u']};assert.equal(w.service().acceptancePolicy('ws',objectiveId),'confirm');assert.equal(w.service().update({objectiveId,autoAccept:true,anchorMessageId:'u'},view).code,'AUTO_ACCEPT_NOT_AUTHORIZED');
  for(const content of ['不要允许自动签收','文件说“允许自动签收”']){w.messages.push({id:'deny',role:'user',kind:'user_input',content});assert.equal(w.service().update({objectiveId,autoAccept:true,anchorMessageId:'deny'},{...view,currentInputAnchors:['deny']}).ok,false);w.messages.pop();}
  w.messages.push({id:'accept',role:'user',kind:'user_input',content:'允许这个目标自动签收任务'});assert.equal(w.service().update({objectiveId,autoAccept:true,anchorMessageId:'accept'},{...view,currentInputAnchors:['accept']}).ok,true);assert.equal(w.service().acceptancePolicy('ws',objectiveId),'auto');w.restart();assert.equal(w.service().acceptancePolicy('ws',objectiveId),'auto');w.messages.pop();assert.equal(w.service().acceptancePolicy('ws',objectiveId),'confirm');
 }finally{w.cleanup();}
});
test('provider rejects forged wake before dispatch and never replays a cached result after report-only downgrade',async()=>{
 const w=world();try{let calls=0;const provider=createDelegationProvider({objectives:w.service(),supervisor:{spawn(){calls++;return {sessionId:'s',status:'queued'};}}});const event=w.event(),context={mode:'project_agent',role:'project_agent',turnId:'turn',conversationId:'c',workspaceId:'ws',messages:w.messages,objectiveWakeIds:[w.item.objectiveId],objectiveWakeEvents:[event],currentInputAnchors:[]};const call={call:{toolCallId:'t',capabilityId:'local.delegation.spawn_session',arguments:task()}};
  assert.equal((await provider.executeCapability(call,context)).result.status,'success');assert.equal(calls,1);w.store.update('ws',w.item.objectiveId,{autonomy:'report_only'});const result=await provider.executeCapability(call,context);assert.match(result.result.outputPreview.legacyResult.output,/objective_report_only/);assert.equal(calls,1);
 }finally{w.cleanup();}
});
test('corrupt device state fails closed rather than resetting quota',()=>{const w=world();try{w.service().prepareSpawn(task(),w.context([w.event()]));writeFileSync(path.join(w.root,'ws/objectives/actions-state.json'),'{broken');assert.throws(()=>w.actions.usage('ws',w.item.objectiveId));}finally{w.cleanup();}});


test('objective wake allows independent verification only for its actual owned task',async()=>{
 let verified=0;const provider=createDelegationProvider({supervisor:{get:()=>({workspaceId:'ws',origin:{objectiveId:'o'}})},verification:{async run(){verified++;return {ok:true,facts:{}};},record(){}}});
 const context={mode:'project_agent',role:'project_agent',workspaceId:'ws',conversationId:'c',turnId:'t',objectiveWakeIds:['other'],currentInputAnchors:[],messages:[]};
 const result=await provider.executeCapability({call:{toolCallId:'t',capabilityId:'local.delegation.verify_session',arguments:{sessionId:'s'}}},context);assert.match(result.result.outputPreview.legacyResult.output,/objective_verification_out_of_scope/);assert.equal(verified,0);const allowed=await provider.executeCapability({call:{toolCallId:'v',capabilityId:'local.delegation.verify_session',arguments:{sessionId:'s'}}},{...context,objectiveWakeIds:['o']});assert.equal(allowed.result.status,'success');assert.equal(verified,1);
});


test('a task_event watch without an optional probe creates actual SDK Evidence and can trigger act',async()=>{
 const w=world();try{const objectiveId=w.item.objectiveId;w.store.update('ws',objectiveId,{watches:[{watchId:'task',kind:'event',source:{type:'task_event',filter:'failed'}}],milestones:[{id:'m',title:'Work',status:'active',sessionIds:['failed-session']}]});
  const runtime=createWatchProbeRuntime({resolveObjective:(ws,id)=>w.store.get(ws,id),resolveWorkspacePath:()=>w.root,canObserve:()=>true,readSessions:()=>[{sessionId:'failed-session',status:'failed'}]});const executionKey='internal-event',execution=await runtime.execute({workspaceId:'ws',objectiveId,watchId:'task',executionKey});assert.equal(execution.result.status,'success');assert.equal(execution.grant.preset,'observe');const observed=execution.result.outputPreview.observation;assert.match(observed.value,/failed-session/);
  const ref='task-evidence';w.evidence.set(ref,{workspaceId:'ws',objectiveId,watchId:'task',executionKey,execution});w.store.appendObservation('ws',{...observed,objectiveId,watchId:'task',observedAt:new Date().toISOString(),evidenceRefs:[ref]},{executionKey});
  const allowed=w.service().prepareSpawn(task(),w.context([{kind:'objective_signal',eventId:'event-task',workspaceId:'ws',objectiveId,watchId:'task',executionKey}]));assert.equal(allowed.ok,true);assert.ok(allowed.objectiveActionId);
 }finally{w.cleanup();}
});

test('failure circuit uses the actual projected spawnedAt order and recovers after a newer success',()=>{
 const w=world();try{for(const row of [{sessionId:'old',status:'accepted',spawnedAt:'2026-09-01T00:00:00Z'},...['a','b','c'].map((id,n)=>({sessionId:id,status:'failed',spawnedAt:`2026-10-01T0${n}:00:00Z`}))])w.sessions.set(row.sessionId,{...row,workspaceId:'ws',origin:{objectiveId:w.item.objectiveId}});
  assert.equal(w.service().prepareSpawn(task(),w.context([w.event(1)])).error,'objective_proposal_required');w.sessions.set('new',{sessionId:'new',status:'accepted',spawnedAt:'2026-10-01T09:00:00Z',workspaceId:'ws',origin:{objectiveId:w.item.objectiveId}});assert.equal(w.service().prepareSpawn(task(),w.context([w.event(2)])).ok,true);
 }finally{w.cleanup();}
});
test('unreadable objective authority always resolves acceptance to confirm',()=>{const w=world();try{writeFileSync(path.join(w.root,'projects/ws/objectives/objectives.json'),'{broken');assert.equal(w.service().acceptancePolicy('ws',w.item.objectiveId),'confirm');}finally{w.cleanup();}});
test('expired proposals do not occupy pending cards or prevent new proposals at the capacity limit',()=>{const w=world('propose');try{for(let n=0;n<128;n++)assert.equal(w.actions.prepare(w.item,task({objectiveId:w.item.objectiveId}),[`old-${n}`]).ok,true);w.clock('2026-10-09T12:00:00Z');assert.equal(w.actions.pending('ws').length,0);assert.equal(w.actions.prepare(w.item,task({objectiveId:w.item.objectiveId}),['fresh']).ok,true);}finally{w.cleanup();}});
