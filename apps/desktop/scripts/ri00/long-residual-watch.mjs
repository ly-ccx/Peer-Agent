import {learnNaturalFingerprint,advanceNaturalSentinel,naturalIdentity} from './natural-residual.mjs';

/**
 * io owns the real hosts and private journal. This controller owns generations,
 * learning/trigger admission and the one-at-a-time capture queue. No timer here
 * is allowed to invoke a business query except bootstrap or an admitted event.
 */
export async function runLongResidualWatch({durationMs,report,io,settleMs=60000,stableSourceMs=300000}){
  if(!Number.isInteger(durationMs)||durationMs<1000||durationMs>14400000)throw Error('bounded_natural_watch_required');
  const began=io.now(),end=began+durationMs;
  const watch=report.longWatch={maxDurationMs:durationMs,generations:[],events:[],episodes:[],phase:'bootstrap',naturalRoots:0};
  let source=await io.source(),pendingSource=source,pendingSince=io.now(),pendingGraph=null;
  let generation,gate={},fingerprint=null,learning=[],sentinel={},quietUntil=0,attempts=0,rebases=0,heartbeat=io.now();
  const event=(kind,details={})=>{const row={kind,relativeMs:io.now()-began,...details};watch.events.push(row);io.progress(watch,gate,row);};
  const remaining=()=>io.remainingReadCpuMs();
  const freeze=(reason)=>{
    if(generation&&!generation.invalidated){generation.invalidated={reason,relativeMs:io.now()-began};event('generation-frozen',{reason,generation:generation.number});}
    gate={};fingerprint=null;learning=[];sentinel={...sentinel,streak:0};watch.phase='waiting-stable-source';
  };
  async function beginGeneration(){
    if(pendingSource.stable===false){watch.phase='waiting-stable-source';event('source-not-stable');return;}
    source=pendingSource;gate={};fingerprint=null;learning=[];
    generation={number:watch.generations.length,sourceSha256:source.sha256,startedMs:io.now()-began,checkpoints:[],naturalLearning:[]};watch.generations.push(generation);
    try{generation.archive=await io.archive(generation.number,source);}catch(error){generation.archiveFailure=error.message;event('archive-failed',{reason:error.message});}
    watch.phase='bootstrap';attempts=0;await checkpoint('bootstrap');
  }
  function armFingerprint(fastBracketed=false){
    fingerprint=learnNaturalFingerprint(learning);if(!fingerprint)return false;
    fingerprint.fastBracketed=fastBracketed;fingerprint.priorQualifiedFast=Boolean(gate.baseline);generation.fingerprint=fingerprint;
    watch.phase=fastBracketed?'armed':'armed-entry-unqualified';event('natural-fingerprint-armed',{generation:generation.number,positions:fingerprint.positions.length,fastBracketed});return true;
  }
  async function checkpoint(reason){
    if(remaining()<20000){watch.phase='passive-budget';event('controlled-budget-reserved');return;}
    const hadBaseline=Boolean(gate.baseline);attempts++;const result=await io.checkpoint(gate,source,`${generation.number}-${reason}-${attempts}`);gate=result.gate;generation.checkpoints.push(result);
    if(gate.status==='invalidated'&&result.validation?.sourceStable===false){freeze('source_changed_during_checkpoint');pendingSince=io.now();return;}
    quietUntil=io.now()+settleMs;
    if(gate.status==='suspect'||gate.status==='confirmed-transition'){
      await capturePositive(reason,hadBaseline);learning=[];return;
    }
    if(gate.status==='slow-at-entry'&&!generation.entryCapture){
      generation.entryCapture={status:gate.status,atMs:io.now()-began};
      if(remaining()>=6000)generation.entryCapture.actions=await io.capture({label:`entry-${generation.number}`,status:gate.status});
      event('entry-slow-state-preserved-without-formation');quietUntil=io.now()+settleMs;
    }
    if(reason==='learning-bracket'&&armFingerprint(hadBaseline&&Boolean(gate.baseline)&&gate.status==='armed'&&result.calibrationStable!==false&&!/unmatched|calibration/.test(gate.reason||'')))return;
    watch.phase='learning';event('bootstrap-checkpoint',{status:gate.status,reason:gate.reason,attempts});
  }
  async function capturePositive(reason,priorQualifiedFast){
    watch.phase='capturing';const episode={number:watch.episodes.length,reason,generation:generation.number,atMs:io.now()-began,initialStatus:gate.status,priorQualifiedFast,checkpoints:[]};watch.episodes.push(episode);
    if(remaining()>=10000){
      const second=await io.checkpoint(gate,source,`${generation.number}-confirm-${episode.number}`);episode.checkpoints.push(second);gate=second.gate;
      if(second.validation?.sourceStable===false){episode.finalStatus=gate.status;freeze('source_changed_during_capture');pendingSince=io.now();return;}
    }
    episode.finalStatus=gate.status;
    if(remaining()>=6000){episode.actions=await io.capture({label:`episode-${episode.number}`,status:gate.status});}
    else episode.actionsSkipped='remaining_cpu_budget';
    if(priorQualifiedFast&&gate.status==='confirmed-transition'){watch.phase='captured-transition';event('transition-captured',{episode:episode.number});return;}
    sentinel={...sentinel,streak:0,lastTriggerMs:io.now(),episodes:Math.max(sentinel.episodes||0,watch.episodes.length)};
    quietUntil=io.now()+settleMs;watch.phase=fingerprint?(fingerprint.fastBracketed?'armed':'armed-entry-unqualified'):'learning';
    event('forensic-episode-preserved',{episode:episode.number,status:gate.status,priorQualifiedFast});
  }
  await beginGeneration();
  while(io.now()<end&&!io.interrupted()&&watch.phase!=='captured-transition'){
    await io.wait(Math.max(1,Math.min(30000,end-io.now(),heartbeat-io.now(),io.nextSourceCheckMs?.()??Infinity)));
    if(io.now()>=heartbeat||io.sourceDirty?.()){
      const renewalDue=io.now()>=heartbeat;if(renewalDue)await io.renew();const next=await io.source();
      if(next.sha256!==pendingSource.sha256||next.stable===false){pendingSource=next;pendingSince=io.now();pendingGraph=null;freeze('source_metadata_changed');}
      if(renewalDue)heartbeat=io.now()+30000;io.progress(watch,gate);
    }
    const batch=await io.collectIfDirty();if(!batch)continue;
    for(const row of batch.rows){
      if(row.origin!=='natural'||!row.matches)continue;watch.naturalRoots++;
      const identity=naturalIdentity(row);if(!identity){sentinel={...sentinel,streak:0};continue;}
      const known=fingerprint?.identity||learning.length&&naturalIdentity(learning[0]);
      if(known&&identity!==known){pendingGraph=identity;pendingSince=io.now();freeze('natural_read_identity_changed');}
      if(watch.phase==='waiting-stable-source'){
        if(pendingGraph&&pendingGraph!==identity){pendingGraph=identity;pendingSince=io.now();}
        if(pendingSource.stable!==false&&io.now()-pendingSince>=stableSourceMs&&(!generation||rebases<2)&&remaining()>=20000){if(generation)rebases++;await beginGeneration();}
        continue;
      }
      if(io.now()<quietUntil)continue;
      if(watch.phase==='learning'){
        if(learning.length<32)learning.push(row);generation.naturalLearning.push({start:row.start,identity});
        const provisional=learnNaturalFingerprint(learning);
        if(provisional&&attempts<2){await checkpoint('learning-bracket');}
        else if(provisional){armFingerprint(false);}
        else if(learning.length>=32){watch.phase='passive-baseline-unavailable';event('baseline-coverage-exhausted');}
        continue;
      }
      if(!['armed','armed-entry-unqualified'].includes(watch.phase)||!fingerprint)continue;
      sentinel=advanceNaturalSentinel(sentinel,fingerprint,row,io.now());
      if(sentinel.trigger){
        const signal={...sentinel,start:row.start,generation:generation.number};event('natural-trigger',signal);
        if(remaining()<22000){watch.phase='passive-budget';event('trigger-without-controlled-budget',signal);continue;}
        const priorQualifiedFast=Boolean(gate.baseline),result=await io.checkpoint(gate,source,`${generation.number}-trigger-${sentinel.episodes}`);generation.checkpoints.push(result);gate=result.gate;
        if(result.validation?.sourceStable===false){freeze('source_changed_during_capture');pendingSince=io.now();}
        else await capturePositive(signal.reason,priorQualifiedFast);
      }
    }
  }
  watch.finishedMs=io.now()-began;watch.endReason=io.interrupted()?'controller-interrupted':watch.phase==='captured-transition'?'transition-captured':'bounded-deadline';
  report.gate=gate;event('watch-ended',{reason:watch.endReason});return watch;
}
