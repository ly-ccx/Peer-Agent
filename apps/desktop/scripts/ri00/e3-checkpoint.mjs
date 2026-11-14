import{advanceDenseResidual}from'./dense-residual.mjs';
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
/** The old G2 gate remains authoritative; ticket/witness data cannot qualify as dense data. */
export function evaluateE3Checkpoint(state,{identity,mainA,reference,mainB,sourceStable,expected}){
 const groups=[mainA,reference,mainB];
 const pmcStable=groups.every(b=>b.points.every(p=>p.pmc.available&&p.pmc.exclusiveWindow));
 const graphStable=groups.every(b=>b.points.length===8&&b.points.every(({row:r})=>r.samplingSchema==='controlled-heap-v1'&&r.readKind==='dense'&&r.rows===expected.sessions
  &&r.planCalls===expected.planCalls&&r.outputSha256===expected.outputSha256&&r.evidence.length===12&&r.evidence.every(e=>e.rows===expected.evidenceRows)&&!r.ledgerTruncated));
 const calibrationRatios=[mainA,mainB].map(b=>median(b.calibration.map(c=>c.userMs+c.systemMs))/median(reference.calibration.map(c=>c.userMs+c.systemMs)));
 const previous=state.calibrationBaseline;
 const calibrationStable=calibrationRatios.every(r=>Number.isFinite(r)&&r>0)
  &&(previous?calibrationRatios.every((r,i)=>Math.abs(r/previous[i]-1)<=.10):Math.abs(calibrationRatios[0]/calibrationRatios[1]-1)<=.10)
  &&groups.every(b=>median(b.points.map(p=>p.row.instrumentationCpuMs??p.row.metadataCpuMs))<=2);
 const validation={sourceStable,pmcStable,graphStable},valid=Object.values(validation).every(Boolean);
 const gate=advanceDenseResidual(state,{identity,valid,calibrationStable,mainA:mainA.points.map(p=>p.row),reference:reference.points.map(p=>p.row),mainB:mainB.points.map(p=>p.row)});
 if(gate.baseline&&!gate.calibrationBaseline)gate.calibrationBaseline=calibrationRatios;
 return {gate,validation,calibrationRatios,calibrationStable};
}
export function qualifiedE3Fast(result){
 return qualifiedE3Dense(result)&&result.gate.status==='armed'&&result.gate.deltas.every(d=>d<15)&&Math.abs(result.gate.summaries[0].median-result.gate.summaries[2].median)<=15;
}
export function qualifiedE3Dense(result){return Boolean(Object.values(result.validation).every(Boolean)&&result.calibrationStable
 &&['armed','suspect','confirmed-transition'].includes(result.gate.status)&&result.gate.deltas
 &&result.gate.summaries?.every(s=>s.compatible>=3&&s.compatibleRange<=15));}
export function qualifiedE3FastPair(first,second){return qualifiedE3Fast(first)&&qualifiedE3Fast(second)&&second.gate.deltas.every((d,i)=>Math.abs(d-first.gate.deltas[i])<=15);}
