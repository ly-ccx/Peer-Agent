import {randomUUID} from 'node:crypto';
import {parseRemoteProjectRequest} from '@peer-agent/protocol';

/** In-flight relay only. Stable input IDs and permission truth stay on the device. */
export function createRemoteProjectRouter({connections,now=Date.now,limit=200,answerTimeoutMs=20_000,requestTtlMs=25_000}={}) {
  if(typeof connections?.route!=='function'||![limit,answerTimeoutMs,requestTtlMs].every(n=>Number.isSafeInteger(n)&&n>0)
      ||requestTtlMs>30_000||answerTimeoutMs>requestTtlMs)throw new Error('INVALID_ROUTER_CONFIG');
  const pending=new Map();
  function current(entry) {
    const route=connections.route(entry.ownerId,entry.deviceId);
    if(route.handle!==entry.handle)throw new Error('STALE_CONNECTION');
    if(route.delegation?.version!==entry.version||route.delegation.expiresAt<=now())throw new Error('DELEGATION_EXPIRED');
    return route;
  }
  return {
    async submit({ownerId,deviceId,operation,requestId=randomUUID(),...fields}={}) {
      if(pending.size>=limit)throw new Error('RATE_LIMITED');
      const at=now();if(!Number.isSafeInteger(at)||at<0)throw new Error('INVALID_CLOCK');
      const route=connections.route(ownerId,deviceId),grant=route.delegation;
      if(!grant)throw new Error('DELEGATION_UNAVAILABLE');
      if(grant.expiresAt<=at)throw new Error('DELEGATION_EXPIRED');
      if(grant.allowProjectRead!==true)throw new Error('PROJECT_DENIED');
      if(operation!=='project.list') {
        const row=grant.projectGrants?.find(row=>row.workspaceId===fields.workspaceId);
        if(!row?.allowProjectRead)throw new Error('PROJECT_DENIED');
        if(operation==='project.input.submit'&&!row.allowProjectMessage)throw new Error('MESSAGE_DENIED');
      }
      const parsed=parseRemoteProjectRequest({protocolVersion:1,type:'project.submit',requestId,ownerId,deviceId,
        bindingVersion:route.bindingVersion,connectionEpoch:route.handle.epoch,delegationVersion:grant.version,
        expiresAt:at+requestTtlMs,operation,...fields});
      if(!parsed.ok)throw new Error(parsed.code);
      const correlationId=randomUUID();
      return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{pending.delete(correlationId);reject(new Error('OUTCOME_UNKNOWN'));},answerTimeoutMs);
        pending.set(correlationId,{resolve,reject,timer,requestId,ownerId,deviceId,operation,handle:route.handle,version:grant.version});
        try{route.send({type:'remote.project.request',protocolVersion:1,correlationId,request:parsed.request});}
        catch{clearTimeout(timer);pending.delete(correlationId);reject(new Error('OUTCOME_UNKNOWN'));}
      });
    },
    /** handle is the server's authenticated socket identity, never a wire field. */
    settle(handle,message) {
      const entry=pending.get(message?.correlationId);
      if(!entry||entry.handle!==handle||entry.requestId!==message.requestId)return false;
      pending.delete(message.correlationId);clearTimeout(entry.timer);
      try{current(entry);
        if(message.status==='ok')entry.resolve({requestId:entry.requestId,status:'ok',result:message.result});
        else entry.reject(new Error(/^[A-Z][A-Z_]{0,63}$/.test(message.code)?message.code:'LOCAL_STATE_UNAVAILABLE'));
      }catch(error){entry.reject(entry.operation==='project.input.submit'?new Error('OUTCOME_UNKNOWN'):error);}
      return true;
    },
    pendingCount:()=>pending.size,
    close(){for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('OUTCOME_UNKNOWN'));}pending.clear();},
  };
}
