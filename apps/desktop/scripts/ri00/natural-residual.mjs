const median=xs=>{const a=[...xs].sort((a,b)=>a-b),n=a.length;return n%2?a[n>>1]:(a[n/2-1]+a[n/2])/2;};
const usable=e=>e.rows>0&&e.gc?.major===0&&e.gc?.incremental===0&&e.newSpaceBefore===67108864&&e.newSpaceAfter===67108864;
export function naturalIdentity(row){
  if(!row.matches||row.origin!=='natural'||row.readFailure||row.metadataFailure||row.evidence.length!==12||row.sourceBefore!==row.sourceAfter)return null;
  return JSON.stringify([row.sourceBefore,row.outputSha256,row.evidence.map(e=>e.rows)]);
}
/** A natural signal requests a controlled comparison; it never proves a CPU residual. */
export function learnNaturalFingerprint(rows){
  const accepted=rows.filter(r=>naturalIdentity(r));if(!accepted.length)return null;
  const identity=naturalIdentity(accepted[0]);if(accepted.some(r=>naturalIdentity(r)!==identity))return null;
  const positions=Array.from({length:12},(_,i)=>{
    const values=accepted.map(r=>r.evidence[i]).filter(usable).map(e=>e.userMs);
    return values.length>=5?{position:i,samples:values.length,medianMs:median(values),minMs:Math.min(...values),maxMs:Math.max(...values)}:null;
  }).filter(Boolean);
  return positions.length>=6?{identity,positions,roots:accepted.length}:null;
}
export function advanceNaturalSentinel(state,fingerprint,row,nowMs,{cooldownMs=600000,maxEpisodes=3}={}){
  if(!Number.isFinite(nowMs))throw Error('natural_monotonic_clock_required');
  const identity=naturalIdentity(row);
  if(!identity||identity!==fingerprint.identity)return {...state,streak:0,trigger:false,reason:'natural_identity_or_graph_mismatch'};
  if(state.lastTriggerMs!=null&&nowMs-state.lastTriggerMs<cooldownMs)return {...state,streak:0,trigger:false,reason:'natural_cooldown'};
  if((state.episodes||0)>=maxEpisodes)return {...state,streak:0,trigger:false,reason:'natural_episode_budget_exhausted'};
  const pairs=fingerprint.positions.filter(p=>usable(row.evidence[p.position])).map(p=>({position:p.position,before:p.medianMs,after:row.evidence[p.position].userMs}));
  const before=pairs.reduce((s,p)=>s+p.before,0),after=pairs.reduce((s,p)=>s+p.after,0),delta=after-before;
  const largePause=row.end-row.start>=2000;
  const eligible=pairs.length>=6,slow=eligible&&delta/pairs.length>=2&&delta/before>=.08;
  const streak=slow?(state.streak||0)+1:0,trigger=largePause||streak>=3;
  return {...state,streak,trigger,reason:largePause?'natural_multi_second':trigger?'natural_sustained_position_cost':eligible?'natural_criterion_not_met':'natural_gc_state_unmatched',
    comparedPositions:pairs.map(p=>p.position),deltaMs:delta,meanPositionDeltaMs:pairs.length?delta/pairs.length:null,
    ...(trigger?{lastTriggerMs:nowMs,episodes:(state.episodes||0)+1}:{}),notDenseResidualConfirmation:true};
}
