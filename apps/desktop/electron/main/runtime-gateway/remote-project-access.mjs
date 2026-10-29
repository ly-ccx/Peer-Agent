import {createHash} from 'node:crypto';
import {admitRemoteProject,generateAvatar,parseRemoteProjectRequest,REMOTE_PROJECT_LIMITS} from '@peer-agent/protocol';

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const state = value => typeof value === 'string' && /^[a-z][a-z_]{0,39}$/.test(value) ? value : 'unknown';
const at = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const inputIdFor = request => `remote-${createHash('sha256').update(JSON.stringify([request.ownerId,request.deviceId,request.requestId])).digest('hex')}`;

/** Text is authorized conversation content, with local path references withheld. */
function text(value,limit,privatePaths=[]) {
  let result = typeof value === 'string' ? value : '';
  for (const path of privatePaths) if (typeof path === 'string' && path.length > 1) result = result.split(path).join('[local path]');
  result = result.replace(/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var|etc|opt|Volumes|Applications)\/)[^\s"'<>`，。；）)]+/g,'[local path]');
  result = result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
  return Array.from(result).slice(0,limit).join('');
}

function sessionProjection(row,paths,summaryLimit=4000) {
  return {sessionId:id(row.sessionId),title:text(row.title,200,paths),status:state(row.status),
    updatedAt:at(row.updatedAt),summary:text(row.report?.summary??row.summary,summaryLimit,paths)};
}

function messageProjection(row,paths) {
  const needsDesktop=(row.cards??[]).some(card=>card?.resolvedState!=='resolved'
    && (card?.kind==='approval'||card?.kind==='plan_approval'||card?.actions?.some(action=>
      ['project-agent:decide-approval','project-agent:confirm-result'].includes(action?.channel))));
  return {id:id(row.id),kind:row.kind,createdAt:at(row.createdAt??row.at),content:text(row.content??row.text,4000,paths),
    replyTo:(Array.isArray(row.replyTo??row.meta?.replyTo)?row.replyTo??row.meta.replyTo:[]).map(id).filter(Boolean).slice(0,8),
    sourceSessionIds:(Array.isArray(row.sources??row.meta?.sources)?row.sources??row.meta.sources:[]).map(id).filter(Boolean).slice(0,8),
    marks:(Array.isArray(row.marks)?row.marks:[]).slice(0,8).map(mark=>({outcome:state(mark.outcome??mark.state)})),
    cards:(Array.isArray(row.cards)?row.cards:[]).filter(card=>card?.resolvedState!=='resolved').slice(0,3)
      .map(card=>({cardId:id(card.cardId),kind:state(card.kind),summary:text(card.content,250,paths)})),
    needsDesktopApproval:needsDesktop};
}

/** resolveLocal reads authority synchronously; UI reads may await and are rechecked. */
export function createRemoteProjectAccess({resolveLocal,receipts,onAccess=()=>{}}) {
  if(typeof resolveLocal!=='function'||!receipts?.lookupProject||!receipts?.rememberProject) throw new Error('INVALID_PROJECT_ACCESS');
  return async function access(value) {
    const parsed=parseRemoteProjectRequest(value);
    if(!parsed.ok)return parsed;
    const request=parsed.request;
    let inputAttempted=false;
    try {
      const local=resolveLocal(request),admission=admitRemoteProject(request,local.admission);
      if(!admission.ok)return admission;
      const ports=local.projectAccess,paths=local.privatePaths??[];
      if(!ports?.directory||!ports?.inputQueue)return {ok:false,code:'RUNTIME_UNAVAILABLE'};
      let result;
      if(request.operation==='project.input.submit') {
        const prior=receipts.lookupProject(request);
        if(prior)result=prior;
        else {
          inputAttempted=true;
          const queued=ports.inputQueue.submitInput({workspaceId:request.workspaceId,inputId:inputIdFor(request),surface:'remote',text:request.text});
          if(queued?.workspaceId!==request.workspaceId||queued?.inputId!==inputIdFor(request)||queued?.text!==request.text.trim()||queued?.surface!=='remote') {
            return {ok:false,code:'REQUEST_CONFLICT'};
          }
          result=receipts.rememberProject(request,{status:'received',inputId:queued.inputId,createdAt:queued.createdAt},local.admission.now);
          // The host owns wake/consumption; failure to wake cannot undo a durable receipt.
          try{void Promise.resolve(ports.wake?.(request.workspaceId)).catch(()=>{});}catch{}
        }
      } else if(request.operation==='project.list') {
        const grants=local.admission.delegation.projectGrants;
        result={projects:(await ports.directory.list()).filter(row=>row.profile?.status==='active'
          && grants.some(grant=>grant.workspaceId===row.workspaceId&&grant.allowProjectRead)).slice(0,REMOTE_PROJECT_LIMITS.projects).map(row=>{
          const generated=generateAvatar(row.workspaceId),avatar=row.profile?.avatar;
          return {workspaceId:id(row.workspaceId),name:text(row.profile?.displayName,160,paths),
            avatar:avatar?.kind==='generated'&&id(avatar.shape)&&/^#[a-fA-F0-9]{6}$/.test(avatar.color)
              ?{kind:'generated',shape:avatar.shape,color:avatar.color,variant:Number.isInteger(avatar.variant)?Math.max(0,Math.min(31,avatar.variant)):0}:generated,
            preview:text(row.preview,80,paths),lastActiveAt:at(row.lastActiveAt),
            state:{needsYou:count(row.state?.needsYou),running:count(row.state?.running),unread:count(row.state?.unread)},
            canMessage:grants.find(grant=>grant.workspaceId===row.workspaceId)?.allowProjectMessage===true};
        })};
      } else if(request.operation==='project.conversation.read') {
        const conversation=await ports.directory.readConversation(request.workspaceId,{limit:request.limit,before:request.before,latest:true,kinds:['user_input','agent_reply','system_card']});
        if(!conversation?.ok)return {ok:false,code:'PROJECT_DENIED'};
        result={workspaceId:request.workspaceId,messages:(conversation.messages??[])
          .filter(row=>['user_input','agent_reply','system_card'].includes(row.kind)).slice(0,request.limit).map(row=>messageProjection(row,paths)),
          nextCursor:id(conversation.nextCursor),
          sessions:(await ports.directory.listSessions(request.workspaceId)).filter(row=>row.workspaceId===request.workspaceId).slice(0,50).map(row=>sessionProjection(row,paths,160)),
          pendingApprovals:(ports.directory.listApprovals?.(request.workspaceId)??[]).filter(row=>['open','stale'].includes(row.state))
            .slice(0,20).map(row=>({state:state(row.state),summary:text(row.summary,250,paths),needsDesktopApproval:true})),
          canMessage:local.admission.delegation.projectGrants.find(grant=>grant.workspaceId===request.workspaceId)?.allowProjectMessage===true};
      } else {
        result={workspaceId:request.workspaceId,...sessionProjection(local.sessionFacts,paths)};
      }
      // An async read may cross a settings change, disconnect, or bot removal.
      const current=resolveLocal(request),exportAdmission=admitRemoteProject(request,current.admission);
      if(!exportAdmission.ok)return request.operation==='project.input.submit'?{ok:false,code:'OUTCOME_UNKNOWN'}:exportAdmission;
      if(request.operation==='project.list')result.projects=result.projects.filter(row=>
        current.admission.delegation.projectGrants.some(grant=>grant.workspaceId===row.workspaceId&&grant.allowProjectRead)
        && current.projectAccess.directory.get(row.workspaceId)?.profile?.status==='active');
      onAccess({at:local.admission.now,operation:request.operation,...('workspaceId' in request?{workspaceId:request.workspaceId}:{})});
      return {ok:true,result};
    }catch(error){return {ok:false,code:error?.message==='REQUEST_CONFLICT'?'REQUEST_CONFLICT':inputAttempted?'OUTCOME_UNKNOWN':'LOCAL_STATE_UNAVAILABLE'};}
  };
}
