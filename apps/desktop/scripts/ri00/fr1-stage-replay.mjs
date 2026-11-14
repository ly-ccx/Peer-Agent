import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {fr1Hash as hash} from './fr1-identity.mjs';
import {replayFr1Journal} from './fr1-journal.mjs';
import {analyzeFr1Stages} from './fr1-stage-analysis.mjs';

/** Source sites are fixed by the producer's eight-site generated-source contract. */
export function reconcileFr1SelfWindows(meter,root,state){
  const clocks=meter.clocks,coarse=meter.stages.filter(x=>x.rootId===root.id&&['root.pre','root.post','root.keep','span.pre','span.post'].includes(x.name));
  const cumulative=c=>{
    if(!c.isDelta)return{user:c.user,system:c.system};
    if(c.role!=='original-8')throw Error('stage_replay_unmapped_delta');
    const prior=clocks.filter(x=>x.id<c.id&&x.role==='original-7'&&!x.isDelta).at(-1);
    if(!prior)throw Error('stage_replay_missing_span_start');
    return{user:prior.user+c.user,system:prior.system+c.system};
  };
  const windows=coarse.map(s=>{
    const startRole=s.name==='span.post'?'original-8':'original-1',endRole=s.name==='span.pre'?'original-7':'original-1';
    const start=clocks.filter(x=>x.role===startRole&&x.endWall<=s.beginClockWall).at(-1);
    const end=clocks.find(x=>x.role===endRole&&x.beginWall>=s.endClockEndWall);
    if(!start||!end)throw Error('stage_replay_missing_self_boundary');
    const a=cumulative(start),b=cumulative(end),userMs=(b.user-a.user)/1000,systemMs=(b.system-a.system)/1000;
    const contained=clocks.filter(x=>x.beginWall>=start.beginWall&&x.endWall<=end.endWall);
    const clockGroups=['original','boundary'].map(role=>{const xs=contained.filter(x=>x.role.startsWith(role));return{role,count:xs.length,
      wallUpperMs:xs.reduce((sum,x)=>sum+x.endWall-x.beginWall,0),exactCpuUnknown:true,includesLegacyBoundaryTails:true};});
    const coveredCpuMs=(s.endUser-s.beginUser+s.endSystem-s.beginSystem)/1000;
    return{name:s.name,span:s.spanPosition,stageId:s.id,startClockId:start.id,endClockId:end.id,
      userMs,systemMs,cpuMs:userMs+systemMs,coveredCpuMs,uncoveredCpuMs:userMs+systemMs-coveredCpuMs,clockGroups};
  });
  const eq=(a,b)=>{if(Math.abs(a-b)>1e-8)throw Error('stage_replay_cpu_boundary_mismatch');};
  for(const [name,wanted]of [['root.pre',root.preSelfMs],['root.post',root.postSelfMs],['root.keep',state.lastRootSelfCpuMs-root.instrumentationCpuMs]]){
    const rows=windows.filter(x=>x.name===name);assert.equal(rows.length,1);eq(rows[0].cpuMs,wanted);
  }
  for(const [i,span]of root.evidence.entries()){
    const rows=windows.filter(x=>x.span===i&&x.name.startsWith('span.'));assert.equal(rows.length,2);eq(rows.reduce((s,x)=>s+x.cpuMs,0),span.selfMs);
  }
  const totalCpuMs=windows.reduce((s,x)=>s+x.cpuMs,0);eq(totalCpuMs+root.planCounterWallUpperMs,state.lastRootSelfCpuMs);
  return{windows,totalCpuMs,coveredCpuMs:windows.reduce((s,x)=>s+x.coveredCpuMs,0),uncoveredCpuMs:windows.reduce((s,x)=>s+x.uncoveredCpuMs,0),
    clocks:['original','boundary'].map(role=>{const xs=windows.flatMap(x=>x.clockGroups).filter(x=>x.role===role);return{role,
      count:xs.reduce((s,x)=>s+x.count,0),wallUpperMs:xs.reduce((s,x)=>s+x.wallUpperMs,0),cpuLowerMs:0,exactCpuUnknown:true,
      notAddedToCpuAgain:true};}),legacyCpuWindowArithmeticExact:true,noClockMeanSubtraction:true};
}

function clockSummary(pairs){
  const median=xs=>{const x=[...xs].sort((a,b)=>a-b);return(x[(x.length-1)>>1]+x[x.length>>1])/2;};
  return['thread','performance'].map(channel=>{
    const rows=pairs.map(p=>channel==='performance'?p.performancePair:p),cpu=rows.map(p=>(p.endUser-p.beginUser+p.endSystem-p.beginSystem)/1000),wall=rows.map(p=>p.endWall-p.beginWall);
    return{channel,pairs:rows.length,cpuBracket:{minMs:Math.min(...cpu),medianMs:median(cpu),maxMs:Math.max(...cpu),sumMs:cpu.reduce((a,b)=>a+b,0)},
      wallBracket:{minMs:Math.min(...wall),medianMs:median(wall),maxMs:Math.max(...wall),sumMs:wall.reduce((a,b)=>a+b,0)},
      exactClockCpu:false,notMultipliedByCallCount:true};
  });
}

export function replayFr1Stages(report,meter,journalText){
  const journal=replayFr1Journal(journalText),roots=journal.records.filter(x=>x.kind==='root');assert.equal(roots.length,1);
  const root=roots[0].value;assert.deepEqual(root,report.root);assert.equal(meter.owner,report.initial.ownerId);
  assert.equal(journal.sha256,report.history.sha256);assert.equal(journal.seq,report.finalRecorder.lastAckSeq);
  assert.equal(report.finalRecorder.lastSeq,journal.seq);assert.equal(report.finalRecorder.retainedBytes,0);
  const analysis=analyzeFr1Stages(meter,root,report.finalRecorder);assert.deepEqual(analysis,report.analysis);
  return{producerCandidate:report.candidate,producerSourceUnmodified:true,journal:{chunks:journal.chunk,records:journal.seq,sha256:journal.sha256},
    analysisReplayedExactly:true,measurementValid:analysis.valid,groups:analysis.groups,coverage:analysis.coverage,
    selfWindows:reconcileFr1SelfWindows(meter,root,report.finalRecorder),controls:clockSummary(report.clockControl.pairs),
    originalGatePassed:report.originalGatePassed,functionalQualification:false,fieldAdmission:false,oldRootNotBackfilled:true};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),opt=k=>args[args.indexOf('--'+k)+1];
  for(const k of ['report','stages','history','output'])if(!args.includes('--'+k))throw Error('stage_replay_inputs');
  const reportText=fs.readFileSync(opt('report')),stagesText=fs.readFileSync(opt('stages')),history=fs.readFileSync(opt('history'),'utf8');
  const report=JSON.parse(reportText),meter=JSON.parse(stagesText);assert.equal(hash(stagesText),report.stageSnapshotSha256);
  const r={...replayFr1Stages(report,meter,history),rawReportSha256:hash(reportText),rawStagesSha256:hash(stagesText),
    rawHistorySha256:hash(history),auditorSourceSha256:hash(fs.readFileSync(fileURLToPath(import.meta.url)))};
  fs.writeFileSync(opt('output'),JSON.stringify(r),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({producer:r.producerCandidate,measurementValid:r.measurementValid,groups:r.groups,
    selfClockWindows:r.selfWindows.clocks,selfCpuMs:r.selfWindows.totalCpuMs,coveredCpuMs:r.selfWindows.coveredCpuMs,
    uncoveredCpuMs:r.selfWindows.uncoveredCpuMs,controls:r.controls,fieldAdmission:false}));
}
