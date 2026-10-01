import { createHash } from 'node:crypto';
import { isMemoryWorkspaceId, validateObjectiveToolInput } from '@peer-agent/runtime-node';

/** A settings click is a real user action. Persist its canonical fact before changing objective authority. */
export function createProjectObjectivesService({service,store,profileStore,conversationStore,enabled=()=>true,holdsLease=()=>true,onAppendedMessage=null}={}) {
  function view(workspaceId){return {workspaceId,conversationId:profileStore.read(workspaceId)?.agentConversationId,currentInputAnchors:[]};}
  function list(payload){if(!isMemoryWorkspaceId(payload?.workspaceId))return {ok:false,code:'INVALID_WORKSPACE'};return service.list({},view(payload.workspaceId));}
  function command(method,payload={}){
    const {workspaceId,objectiveId,requestId}=payload;
    if(!isMemoryWorkspaceId(workspaceId)||typeof objectiveId!=='string'||typeof requestId!=='string'||!requestId||requestId.length>200)return {ok:false,code:'INVALID_INPUT'};
    if(!enabled()||profileStore.read(workspaceId)?.status!=='active')return {ok:false,code:'PROJECT_AGENT_DISABLED'};
    if(!holdsLease(workspaceId))return {ok:false,code:'NOT_HOST'};
    const item=store.get(workspaceId,objectiveId);if(!item)return {ok:false,code:'NOT_FOUND'};
    const patch=payload.patch || {};
    if(Object.keys(payload).some(key=>!['workspaceId','objectiveId','requestId','patch','expectedVersion'].includes(key))
      ||(payload.expectedVersion!==undefined&&(!Number.isInteger(payload.expectedVersion)||payload.expectedVersion<1)))return {ok:false,code:'INVALID_INPUT'};
    if(method==='update'&&(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(key=>!['autoAccept','title','outcome','autonomy','watches','milestones','successSignals','budget','deadline'].includes(key))
      ||!validateObjectiveToolInput('update_objective',{...patch,objectiveId}).ok))return {ok:false,code:'INVALID_INPUT'};
    let action=method==='update'?(patch.autonomy==='act'?'持续目标允许直接处理，发现问题就直接修':patch.autonomy==='report_only'?'持续目标只报告变化':patch.autonomy==='propose'?'持续目标先提议再执行':(item.autonomy==='act'?'调整持续目标计划，继续直接处理':'调整持续目标计划')):method==='resume'?(item.autonomy==='act'?'确认并恢复这个目标，发现问题就直接修':'确认并恢复这个持续目标'):method==='pause'?'暂停这个目标':'放弃这个目标';
    if(method==='update'&&patch.autoAccept!==undefined)action+=patch.autoAccept?';允许这个目标自动签收任务':';关闭这个目标自动签收任务';
    if(method==='update'&&patch.budget)action+=`;每天自动任务上限调整到 ${patch.budget.maxAutoSessionsPerDay};每天探测上限调整到 ${patch.budget.maxProbeRunsPerDay}`;
    const fingerprint=createHash('sha256').update(JSON.stringify({workspaceId,objectiveId,method,patch})).digest('hex');
    const messageId=`objective-command:${createHash('sha256').update(`${workspaceId}:${requestId}`).digest('hex')}`;
    const context=view(workspaceId),history=conversationStore.getPersistedConversationHistory(context.conversationId)?.messages || [];
    const existing=history.find(m=>m.id===messageId);
    if(existing&&(existing.meta?.objectiveCommandFingerprint!==fingerprint))return {ok:false,code:'REQUEST_ID_REUSED'};
    if(!existing){const appended=conversationStore.appendMessage(context.conversationId,{id:messageId,role:'user',kind:'user_input',content:action,
      meta:{objectiveId,objectiveCommand:method,objectiveCommandFingerprint:fingerprint}});if(!appended)return {ok:false,code:'USER_FACT_WRITE_FAILED'};
      onAppendedMessage?.({conversationId:context.conversationId,message:appended});}
    const input={...(method==='update'?patch:{}),objectiveId,anchorMessageId:messageId,...(payload.expectedVersion!==undefined?{expectedVersion:payload.expectedVersion}:{}),...(method==='close'?{status:'abandoned'}:{})};
    return service[method](input,{...context,currentInputAnchors:[messageId],commandId:messageId,commandFingerprint:fingerprint});
  }
  return {list,update:p=>command('update',p),pause:p=>command('pause',p),resume:p=>command('resume',p),delete:p=>command('close',p)};
}
