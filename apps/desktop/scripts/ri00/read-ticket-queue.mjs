/** Serialized with the probe. Requests enqueue metadata; only setImmediate executes reads. */
export function createReadTicketQueue(probe,{owner,epoch,allowExposure=false,maxQueueMs=5000}={}){
  if(typeof owner!=='string'||!owner||owner.length>128||typeof epoch!=='string'||!epoch||epoch.length>128
    ||!Number.isInteger(maxQueueMs)||maxQueueMs<1||maxQueueMs>5000)throw Error('read_ticket_config_invalid');
  const {performance}=process.getBuiltinModule('perf_hooks');
  let slot=null,lastAck=null,lastId=0,immediate,timer,stopped=false,stopReason,execute;
  const terminal=t=>['completed','failed','expired'].includes(t.state);
  const view=t=>t?{...t,completedRows:t.completedRows.map(r=>({...r})),...(t.error?{error:{...t.error}}:{})}:null;
  function cancelHandles(){clearImmediate(immediate);clearTimeout(timer);immediate=timer=undefined;}
  function expire(reason){if(slot?.state==='queued'){slot.state='expired';slot.reason=reason;slot.finishedMs=performance.now();cancelHandles();}}
  function run(){
    immediate=undefined;if(!slot||slot.state!=='queued'||stopped)return;
    if(performance.now()>=slot.deadlineMs){expire('queue-deadline');return;}
    const context=probe.queueContext();
    if(context.stopped||!context.owned){expire(context.stopped?'probe-stopped':'method-owner-changed');return;}
    if(context.activeDepth){expire('active-read-at-dispatch');return;}
    clearTimeout(timer);timer=undefined;slot.state='started';slot.startedMs=performance.now();
    const sequence=slot.kind==='order-index-first'?[...Array(8).fill('exposure-index'),'exposure-supervisor']:
      slot.kind==='order-supervisor-first'?['exposure-supervisor',...Array(8).fill('exposure-index')]:[slot.kind];
    try{
      for(let i=0;i<sequence.length;i++){
        if(stopped||probe.queueContext().stopped)throw Error('read_ticket_stopped_during_run');
        const row=execute(sequence[i],slot.label,{id:slot.id,epoch,step:i});
        slot.completedRows.push({step:i,kind:sequence[i],start:row.start,end:row.end,cpuMs:row.userMs+row.systemMs,rows:row.rows});
      }
      slot.state='completed';
    }catch(error){slot.state='failed';slot.error={name:error.name||'Error',message:String(error.message),code:error.code??null};}
    finally{slot.finishedMs=performance.now();slot.stoppedDuringRun=stopped;}
  }
  const queue={
    request({id,kind,label,sourceEpoch=epoch,ttlMs=maxQueueMs}={}){
      if(!Number.isSafeInteger(id)||id<1||!['dense','witness','order-index-first','order-supervisor-first'].includes(kind)
        ||typeof label!=='string'||!label||label.length>128||sourceEpoch!==epoch||!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>maxQueueMs
        ||kind.startsWith('order-')&&!allowExposure)throw Error('read_ticket_request_invalid');
      if(slot){if(slot.id===id&&slot.kind===kind&&slot.label===label&&slot.ttlMs===ttlMs)return view(slot);throw Error('read_ticket_slot_occupied');}
      if(lastAck?.id===id){if(lastAck.kind!==kind||lastAck.label!==label||lastAck.ttlMs!==ttlMs)throw Error('read_ticket_request_conflict');return {...lastAck};}
      if(stopped||probe.queueContext().stopped)throw Error('read_ticket_queue_stopped');
      if(id<=lastId)throw Error('read_ticket_stale_id');
      lastId=id;const now=performance.now();slot={id,owner,epoch,kind,label,ttlMs,createdMs:now,deadlineMs:now+ttlMs,state:'queued',completedRows:[]};
      immediate=setImmediate(run);timer=setTimeout(()=>expire('queue-deadline'),ttlMs);timer.unref?.();return view(slot);
    },
    status(id){if(slot?.id===id)return view(slot);if(lastAck?.id===id)return {...lastAck};throw Error('read_ticket_unknown');},
    ack(id){
      if(lastAck?.id===id)return true;
      if(!slot||slot.id!==id||!terminal(slot))throw Error('read_ticket_ack_invalid');
      lastAck={id,owner,epoch,kind:slot.kind,label:slot.label,ttlMs:slot.ttlMs,state:'acknowledged',previousState:slot.state};slot=null;cancelHandles();return true;
    },
    snapshot(){return {owner,epoch,stopped,stopReason,lastId,ticket:view(slot),lastAck:lastAck?{...lastAck}:null,
      immediatePending:immediate!==undefined,deadlinePending:timer!==undefined,inFlight:slot?.state==='started'};},
    stop(reason='controller'){stopped=true;stopReason??=reason;cancelHandles();expire('queue-stopped');return queue.snapshot();}
  };
  execute=probe.attachReadQueue(queue);return queue;
}
