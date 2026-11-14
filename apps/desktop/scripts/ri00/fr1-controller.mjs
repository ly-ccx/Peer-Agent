import {createFr1Policy}from'./fr1-policy.mjs';
/** Only the IO adapter owns attachment. This policy never has a business-query capability. */
export async function runFr1Controller({io,report,startedMs,deadlineMs=startedMs+1800000}){
 const policy=createFr1Policy({startedMs,deadlineMs});let lastRenew=startedMs,nativeJob,profileClaimed=false,nativeFailure;
 report.phase='observing';
 try{
  while(!policy.state().stopped){
   if(nativeFailure)throw nativeFailure;if(io.cancelled())throw Error('fr1_cancelled');if(!io.budget())throw Error('fr1_resource_budget');const now=io.now();
   if(io.terminal())throw Error('fr1_recorder_stopped:'+io.terminal());
   if(io.heartbeatAge()>=1000&&!nativeJob&&now+95000<=deadlineMs){
    const signal=policy.heartbeatAbsent(now);await io.control('heartbeat-signal',signal);nativeJob=io.nativeSample();
    nativeJob.catch(e=>{nativeFailure=e;});report.nativeSampleAttempted=true;
   }
   // Do not send metadata evaluations into a blocked main thread and turn a stall into an RPC timeout.
   if(io.heartbeatAge()<1000){
    if(now-lastRenew>=30000){await io.renew();lastRenew=now;}
    if(io.dataReady()){
     const batch=await io.drain();const records=io.forPolicy(batch.records);policy.observe(records,io.now());
     report.observation=policy.state();await io.control('policy',report.observation);
    }
    const s=policy.state();
    if(s.event?.phase==='first-witness-sealed'){
     if(policy.profileClaim()){await io.control('first-witness-durable-before-profile',policy.state().event);await io.armProfile();profileClaimed=true;}
     else policy.sealEpisode();
    }
    if(profileClaimed){const p=await io.profileState();if(p.phase==='done'){report.profile=await io.saveProfile();policy.sealEpisode();}}
   }
   policy.tick(io.now());report.observation=policy.state();await io.progress(report);if(!policy.state().stopped)await io.wait(100);
  }
  report.reason=policy.state().reason;
 }catch(error){report.failures.push({message:error.message,stack:error.stack});report.reason=error.message;}
 finally{
  if(nativeJob)try{report.nativeSample=await nativeJob;}catch(error){report.failures.push({message:'native:'+error.message});}
  report.observation=policy.state();report.phase='stopping';
  try{report.recovery=await io.stop(report.reason||'controller-complete');}catch(error){report.recovery={restored:false,error:error.message};report.failures.push({message:'recovery:'+error.message});}
  report.phase='sealed';report.performanceQualified=false;report.fieldCauseEstablished=false;report.RI00Closed=false;report.refactorStarted=false;
 }
 return report;
}
