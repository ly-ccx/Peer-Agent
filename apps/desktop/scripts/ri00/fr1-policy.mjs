const median=xs=>{const a=[...xs].sort((a,b)=>a-b);return(a[(a.length-1)>>1]+a[a.length>>1])/2;};
/** Consumes durable natural facts only. It cannot request reads or learn a green replacement baseline. */
export function createFr1Policy({startedMs,deadlineMs=startedMs+1800000}={}){
 if(!Number.isFinite(startedMs)||!Number.isFinite(deadlineMs)||deadlineMs<=startedMs)throw Error('fr1_policy_clock');
 const cohorts=new Map(),kinds=new Set();let foreground=false,event,stopped=false,reason,roots=0,cpuUsed=0,wallUsed=0,profileOffered=false,complete=false;
 const state=()=>({stopped,reason,roots,kinds:[...kinds],foreground,cohorts:[...cohorts].map(([key,c])=>({key,roots:c.roots.length,baseline:c.baseline})),
  event:event?structuredClone(event):null,cpuUsed,wallUsed,profileOffered,wholeQueryChangeCandidate:Boolean(event?.wholeQueryChangeCandidate),performanceQualified:false,fieldCauseEstablished:false});
 function stop(why){stopped=true;reason=why;return state();}
 function offer(type,details,now){
  if(event){if(!event.reasons.includes(type))event.reasons.push(type);return;}
  if(now+260000>deadlineMs)return;
  if(type==='cpu'&&cpuUsed||type!=='cpu'&&wallUsed)return;
  if(type==='cpu')cpuUsed++;else wallUsed++;
  event={type,reasons:[type],...details,at:now,followupDeadlineMs:now+120000,followups:[],phase:'first-witness'};
 }
 return {state,stop,
  observe(records,now){if(stopped)return state();
   for(const record of records){
    if(record.kind==='entry-start'){const e=record.value;if(e.kind.startsWith('ipc-')||e.kind==='directory-list')kinds.add(e.kind);foreground||=e.foregroundDelivery===true;}
    if(record.kind!=='root')continue;const r=record.value;roots++;
    if(r.phase!=='unused'||r.readFailure||r.metadataFailure||r.asyncRoot)continue;
    const shape=r.evidence.map(e=>e.rows),key=JSON.stringify([r.rootMethod,r.scope,r.epoch,r.sourceBefore,r.outputSha256,r.planCalls,r.portSequence,shape]);
    const comparable=r.identityComplete&&r.sourceBefore===r.sourceAfter&&r.evidence.length===12&&r.evidence.every(e=>Number.isFinite(e.rows)&&e.rows>0&&!e.readFailure)&&r.outputSha256;
    let c=cohorts.get(key);
    if(comparable&&!c){if(cohorts.size>=4)return stop('cohort-cap');cohorts.set(key,c={roots:[],baseline:null});}
    if(event&&event.followups.length<3&&event.cohortKey===key&&comparable&&r.id!==event.rootId){
      event.followups.push({rootId:r.id,userMs:r.userMs,evidenceUserMs:r.evidenceUserMs,phase:r.phase,start:r.start,end:r.end,samplerOverlap:Boolean(r.samplerOverlap)});
      if(event.followups.length===3){
       event.wholeQueryChangeCandidate=Boolean(event.baseline)&&!event.baseline.diagnosticOverlap&&event.followups.every(x=>!x.samplerOverlap&&x.userMs-event.baseline.root>=25&&(x.userMs/event.baseline.root-1)>=.08);
       event.evidenceChangeCandidate=Boolean(event.baseline)&&!event.baseline.diagnosticOverlap&&event.followups.every(x=>!x.samplerOverlap&&x.evidenceUserMs-event.baseline.evidence>=25&&(x.evidenceUserMs/event.baseline.evidence-1)>=.08);
       event.outcome=event.wholeQueryChangeCandidate?'whole-query-change-candidate':event.evidenceChangeCandidate?'redistribution-candidate':'transient-or-unconfirmed';event.phase='first-witness-sealed';
      }
    }
    if(event?.type==='heartbeat'&&!event.rootId&&r.start<=event.at&&r.end>=event.at){event.rootId=r.id;event.cohortKey=comparable?key:null;event.baseline=c?.baseline||null;}
    if(r.end-r.start>=1000)offer('wall',{rootId:r.id,cohortKey:comparable?key:null,baseline:c?.baseline||null,wallMs:r.end-r.start},now);
    if(!c)continue;
    if(!c.baseline){c.roots.push({rootId:r.id,root:r.userMs,evidence:r.evidenceUserMs,samplerOverlap:Boolean(r.samplerOverlap)});if(c.roots.length===9){const root=median(c.roots.map(x=>x.root)),evidence=median(c.roots.map(x=>x.evidence));
      c.baseline={root,evidence,rootMad:median(c.roots.map(x=>Math.abs(x.root-root))),evidenceMad:median(c.roots.map(x=>Math.abs(x.evidence-evidence))),rootIds:c.roots.map(x=>x.rootId),diagnosticOverlap:c.roots.some(x=>x.samplerOverlap)};}continue;}
    if(event)continue;const b=c.baseline,dr=r.userMs-b.root,de=r.evidenceUserMs-b.evidence;
    if(dr>=Math.max(12,.04*b.root,3*b.rootMad)||de>=Math.max(12,.04*b.evidence,3*b.evidenceMad))
      offer('cpu',{rootId:r.id,cohortKey:key,baseline:structuredClone(b),rootDeltaMs:dr,evidenceDeltaMs:de},now);
   }
   return this.tick(now);
  },
  heartbeatAbsent(now){if(!stopped)offer('heartbeat',{cohortKey:null,baseline:null},now);return state();},
  tick(now){if(stopped)return state();if(now>=deadlineMs-90000)return stop('field-deadline-cleanup');
    if(event&&event.phase==='first-witness'&&now>=event.followupDeadlineMs){event.phase='first-witness-sealed';event.outcome='transient-or-unconfirmed';}
    if(!event&&now-startedMs>=600000&&(!foreground||kinds.size<2||![...cohorts.values()].some(c=>c.baseline)))return stop('coverage-insufficient');
    if(roots>=1500)return stop('natural-root-cap');return state();},
  profileClaim(){if(!event||event.phase!=='first-witness-sealed'||event.followups.length!==3||!event.baseline||profileOffered)return false;profileOffered=true;event.phase='optional-stack';return true;},
  sealEpisode(){complete=true;if(event)event.phase='sealed';return stop('first-episode-sealed');}
 };
}
