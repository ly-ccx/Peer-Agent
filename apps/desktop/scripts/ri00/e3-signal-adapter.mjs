const median = xs => { const a=[...xs].sort((x,y)=>x-y); return a[Math.floor(a.length/2)]; };
const fullIdentity = row => row.origin === 'natural' && row.matches && (!row.rootMethod || row.rootMethod === 'list')
  && row.samplingSchema === 'passive-cpu-v2' && !row.readFailure && !row.metadataFailure && row.sourceBefore === row.sourceAfter
  && row.evidence.length === 12 && row.evidence.every(e => e.rows > 0)
  ? JSON.stringify([row.sourceBefore,row.outputSha256,row.evidence.map(e=>e.rows)]) : null;
const keyOf = entry => JSON.stringify([entry.kind,entry.shapeDigest,entry.portSequence]);

/** Pure controller policy. Signals return metadata, never call a product entry or confirm G2. */
export function createE3SignalAdapter({ epoch, startedMs, expectedIdentity, maxEvents = 2 } = {}) {
  if (!epoch || !Number.isFinite(startedMs) || !expectedIdentity || !Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 2) throw Error('e3_signal_contract_required');
  const learning=[],known=new Set(),used=new Set(),seenRoots=new Set();let baseline,bracketed=false,stopped=false,reason,pending,inFlight,events=0,lastNewExposureMs=startedMs,lastNow=startedMs,lastMarkers=[];
  function stop(why) { stopped=true;reason=why;pending=null;return api.state(); }
  function offer(exposure, signal, detail) {
    if (used.has(exposure)) return;
    if (pending) { if (!pending.reasons.includes(signal)) pending.reasons.push(signal);if(pending.exposure!==exposure)pending.coalescedDifferentExposure=true; return; }
    if (inFlight || events >= maxEvents) return;
    pending={id:events+1,exposure,reasons:[signal],detail,notDenseResidualConfirmation:true};
  }
  const api = {
    observe({ rows=[], entries=[], nowMs, sourceEpoch=epoch, sourceStable=true, diagnosticSpans=[] }={}) {
      if(stopped)return api.state();
      if(!Number.isFinite(nowMs)||nowMs<lastNow)throw Error('e3_signal_clock_required');lastNow=nowMs;lastMarkers=[];
      if(rows.length>256||entries.length>256)return stop('signal-batch-cap');
      if(sourceEpoch!==epoch||!sourceStable)return stop('source-epoch-changed');
      for(const entry of entries){
        if(entry.epoch!==epoch||entry.truncated)return stop('entry-identity-or-overflow');
        if(entry.end===null||!entry.portSequence.length)continue;
        const key=keyOf(entry),novel=!known.has(key);if(novel&&known.size>=256)return stop('signal-exposure-cap');known.add(key);
        if(novel){lastNewExposureMs=nowMs;if(baseline&&bracketed)offer(key,'new-mapped-exposure',{kind:entry.kind,seq:entry.seq});}
      }
      for(const row of rows){
        if(row.origin!=='natural')continue;
        const identity=fullIdentity(row);
        if(!identity){if(row.matches&&(!row.rootMethod||row.rootMethod==='list'))return stop('natural-read-graph-changed');continue;}
        if(identity!==expectedIdentity)return stop('natural-input-output-changed');
        // Retain overlapping rows in the journal; they cannot train or trigger an uncontaminated comparison.
        if(diagnosticSpans.some(s=>Math.max(row.start,s.start)<Math.min(row.end,s.end)))continue;
        const rootKey=JSON.stringify([row.start,row.end,row.entryContext?.seq??null]);if(seenRoots.has(rootKey))continue;
        if(seenRoots.size>=256)return stop('signal-root-cap');seenRoots.add(rootKey);
        const total=row.evidence.reduce((n,e)=>n+e.userMs,0);
        if(!baseline){
          if(nowMs>=startedMs+60000&&learning.length<5)learning.push(row);
          if(learning.length===5)baseline={totalMs:median(learning.map(r=>r.evidence.reduce((n,e)=>n+e.userMs,0))),
            positions:row.evidence.map((_,i)=>median(learning.map(r=>r.evidence[i].userMs)))};
          continue;
        }
        if(!bracketed)continue;
        const entry=entries.find(e=>e.seq===row.entryContext?.seq&&e.end!==null);
        const exposure=entry?keyOf(entry):JSON.stringify(['unmapped-root',row.rootMethod||'list',row.portSequence]);
        const delta=total-baseline.totalMs,markers=row.evidence.flatMap((e,i)=>e.userMs-baseline.positions[i]>=6?[i]:[]);
        if(markers.length)lastMarkers.push({start:row.start,positions:markers});
        if(row.end-row.start>=2000)offer(exposure,'multi-second-wall',{totalMs:total,deltaMs:delta,markers});
        else if(delta>=12&&delta/baseline.totalMs>=.04)offer(exposure,'full12-user-cpu',{totalMs:total,deltaMs:delta,markers});
      }
      if(!baseline&&nowMs>=startedMs+480000)return stop('natural-baseline-unavailable');
      if(baseline&&bracketed&&!pending&&!inFlight&&nowMs-lastNewExposureMs>=480000)return stop('no-new-exposure-coverage');
      return api.state();
    },
    bracket({ f0Qualified, f1QualifiedFast }={}) { if(!f0Qualified||!f1QualifiedFast)return stop('dense-fast-bracket-unqualified');bracketed=true;lastNewExposureMs=Math.max(lastNow,lastNewExposureMs);return api.state(); },
    claim({ queueBusy=false }={}) {
      if(stopped||queueBusy||inFlight||!pending)return null;
      inFlight=pending;pending=null;events++;used.add(inFlight.exposure);return structuredClone(inFlight);
    },
    complete(id) { if(inFlight?.id!==id)throw Error('e3_signal_unknown_event');inFlight=null;return api.state(); },
    stop,
    state() { return { stopped,reason,baseline,learningRoots:learning.length,bracketed,events,pending:pending?structuredClone(pending):null,inFlight:inFlight?structuredClone(inFlight):null,knownExposures:known.size,lastMarkers:structuredClone(lastMarkers),
      notDenseResidualConfirmation:true }; },
  };
  return api;
}
export function e3NaturalIdentity(row) { return fullIdentity(row); }
