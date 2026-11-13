import{qualifiedE3Fast,qualifiedE3FastPair,qualifiedE3Dense}from'./e3-checkpoint.mjs';
import{createE3SignalAdapter}from'./e3-signal-adapter.mjs';

/** Complete ordering policy. IO owns actual G2/identity/durable tickets and leases; this Module never starts a profiler. */
export async function runE3FieldController({io,report={},durationMs=1800000}){
 if(!Number.isInteger(durationMs)||durationMs<1000||durationMs>1800000)throw Error('e3_field_duration_required');
 const began=io.now(),end=began+durationMs,run=report.controller={phase:'initializing',checkpoints:[],events:[],notFieldCause:io.notFieldCause===true};let anchor,gate={},policy,identity;
 async function guard(action){if(io.cancelled())throw Error('e3_field_cancelled');if(io.now()>=end)throw Error('e3_field_deadline');if(!io.admit(action))throw Error('e3_field_budget');const next=await io.identity();if(!next.stable||!next.ownersIntact||identity&&next.key!==identity.key)throw Error('e3_field_epoch_or_owner_changed');identity=next;}
 async function checkpoint(label){await guard('checkpoint');if(run.checkpoints.length>=6)throw Error('e3_field_checkpoint_cap');run.phase=label;const cp=await io.checkpoint(gate,label);run.checkpoints.push({label,result:cp});gate=cp.gate;await io.append('checkpoint-result',{label,result:cp});await guard('metadata');return cp;}
 async function witness(label){await guard('witness');run.phase=label;await io.append('history-sealed-before-witness',{label});const rows=await io.witnessSequence(label);if(rows.length!==3||rows.some(r=>r.readKind!=='witness'||r.heapBefore!==null||r.heapAfter!==null||r.samplingSchema!=='heap-free-witness-v1'))throw Error('e3_field_witness_contract');await io.append('heap-free-first-witness',{label,rows});return rows;}
 async function confirm(label,first=null){gate={...gate,streak:first?.gate.streak||0};const a=first||await checkpoint(label+'-Q1'),b=await checkpoint(label+'-Q2');
  const confirmed=qualifiedE3Dense(a)&&qualifiedE3Dense(b)&&a.gate.status==='suspect'&&b.gate.status==='confirmed-transition';
  await io.append('confirmation',{label,confirmed});if(confirmed){run.phase='captured-transition';run.reason='two-qualified-dense-checks';}return confirmed;
 }
 try{
  await guard('metadata');const f0=await checkpoint('F0');if(!qualifiedE3Fast(f0)){run.reason='F0-unqualified';return run;}anchor=f0;
  policy=createE3SignalAdapter({epoch:identity.epoch,startedMs:io.now(),expectedIdentity:io.expectedNaturalIdentity(f0)});run.phase='learning';
  while(!policy.state().baseline){await guard('metadata');const packet=await io.collect(end);policy.observe(packet);if(policy.state().stopped){run.reason=policy.state().reason;return run;}}
  run.naturalBaseline=policy.state().baseline;await witness('pre-F1');const f1=await checkpoint('F1');
  if(qualifiedE3Dense(f1)&&f1.gate.status==='suspect'){await confirm('learning-transition',f1);if(run.phase!=='captured-transition')run.reason='F1-slow-not-confirmed';return run;}
  if(!qualifiedE3FastPair(anchor,f1)){run.reason='F1-unqualified-or-drift';return run;}
  policy.bracket({f0Qualified:true,f1QualifiedFast:true});run.phase='armed';
  while(io.now()<end){await guard('metadata');policy.observe(await io.collect(end));const s=policy.state();if(s.stopped){run.reason=s.reason;return run;}
   const event=policy.claim({queueBusy:io.queueBusy()});if(!event)continue;run.events.push(event);await witness('event-'+event.id);gate={...gate,streak:0};
   if(await confirm('event-'+event.id))return run;policy.complete(event.id);run.phase='armed';if(policy.state().events>=2){run.reason='two-exposure-cap';return run;}
  }
  run.reason='e3_field_deadline';return run;
 }catch(error){run.reason=error.message;run.error={name:error.name,message:error.message};return run;}
 finally{run.signal=policy?.state();run.finishedMs=io.now()-began;try{await io.append('controller-sealed',{reason:run.reason,phase:run.phase});}catch(error){run.journalFailure=error.message;}
  try{run.recovery=await io.stop(run.reason||'controller-complete');}catch(error){run.recovery={restored:false,error:error.message};}
  if(!run.recovery?.restored||run.journalFailure){run.outcomeBeforeRecoveryFailure=run.reason;run.reason='e3_field_recovery_or_journal_unverified';}
  run.policyConfirmed=run.phase==='captured-transition'&&run.recovery?.restored&&!run.journalFailure&&!run.error;run.fieldFormationCandidate=run.policyConfirmed&&!run.notFieldCause;
  if(run.phase==='captured-transition'&&!run.policyConfirmed)run.phase='sealed-unverified';
  run.finalGate=gate;run.anchorRetained=Boolean(anchor);run.profileStarted=false;
 }
}
