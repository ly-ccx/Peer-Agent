import{summarizeDenseBlock}from'./dense-residual.mjs';
/** Instrument qualification only: never creates a G2 baseline without its same-birth reference. */
export function evaluatePassWorkTarget(r,expected){
 const summaries=r.blocks.map(b=>summarizeDenseBlock(b.points.map(p=>p.row))),on=r.blocks.map((b,i)=>({...b,summary:summaries[i]})).filter(b=>b.enabled),off=r.blocks.map((b,i)=>({...b,summary:summaries[i]})).filter(b=>!b.enabled);
 if(on.length!==2||off.length!==2)throw Error('pass_work_fixed_schedule_required');
 const differences=on.map((b,i)=>b.summary.median-off[i].summary.median);
 const instructionGap=p=>{const outer=p.pmc.levels.reduce((n,l)=>n+BigInt(l.instructions),0n);return Number(outer-BigInt(p.work.root.instructions))/Number(outer);};
 const checks={allGraphs:r.blocks.every(b=>b.points.length===8&&b.points.every(p=>p.row.evidence.length===12&&p.row.planCalls===expected.planCalls&&p.row.rows===expected.sessions&&p.row.outputSha256===expected.outputSha256&&p.row.evidence.every(e=>e.rows===expected.evidenceRows))),
 exclusive:r.blocks.every(b=>b.points.every(p=>p.pmc.available&&p.pmc.exclusiveWindow)),boundary:on.every(b=>b.points.every(p=>p.work?.boundaryWallMs<=1&&p.work.counterCpuUpperMs<=1)),
 counters:on.every(b=>b.points.every(p=>{if(!p.work||!p.pmc.available)return false;const gap=instructionGap(p);return gap>=0&&gap<=.01&&Math.abs(p.work.root.cpuMs-p.pmc.cpuMs)<=Math.max(2,p.pmc.cpuMs*.05);})),
 medianOverhead:differences.every(d=>Number.isFinite(d)&&Math.abs(d)<=2),returnStability:Math.abs(on[0].summary.median-on[1].summary.median)<15&&Math.abs(off[0].summary.median-off[1].summary.median)<15,
 unchangedWarmGate:summaries.every(s=>s.compatible>=3&&s.compatibleRange<=15)};
 return{checks,passed:Object.values(checks).every(Boolean),summaries,differences,warmRanges:summaries.map(s=>s.compatibleRange),notG2Qualification:true,
 maximumBoundaryWallMs:Math.max(...on.flatMap(b=>b.points.map(p=>p.work?.boundaryWallMs??Infinity))),maximumBoundaryCpuMs:Math.max(...on.flatMap(b=>b.points.map(p=>p.work?.counterCpuUpperMs??Infinity))),maximumInstructionGap:Math.max(...on.flatMap(b=>b.points.map(p=>p.work&&p.pmc.available?instructionGap(p):Infinity)))};
}
