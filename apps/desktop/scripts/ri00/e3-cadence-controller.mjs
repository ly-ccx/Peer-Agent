import{cadencePlan}from'./e3-cadence-plan.mjs';import{evaluateE3Checkpoint,qualifiedE3Fast}from'./e3-checkpoint.mjs';import{evaluatePBlockPair}from'./e3-p-result.mjs';import{cadenceBlockGaps,evaluateCadenceTarget}from'./e3-cadence-result.mjs';
/** Orchestrates one immutable schedule; IO owns real processes, durable tickets and cumulative budget. */
export async function runCadenceCampaign({io,expected,identity,report}){
 const plan=cadencePlan(),reference=await io.open('cadence-reference');await io.warm(reference,plan.referenceWarmRoots);
 for(const spec of plan.targets){const host=await io.open(spec.label),t={label:spec.label,order:spec.order,f0Blocks:[],cells:[]};report.targets.push(t);await io.warm(host,spec.warmRoots);
  for(let i=0;i<spec.f0.length;i++)t.f0Blocks.push(await io.block(spec.f0[i].role==='target'?host:reference,spec.f0[i],spec.label+'-F0-'+i));
  t.f0=evaluateE3Checkpoint({},{identity,mainA:t.f0Blocks[0],reference:t.f0Blocks[1],mainB:t.f0Blocks[2],sourceStable:await io.identity(),expected});
  if(!qualifiedE3Fast(t.f0)){t.result={controlsQualified:false,reason:'original-F0-fast-bracket-rejected'};await io.checkpoint(t);await io.close(host);continue;}
  t.reservation=await io.reserve(t.f0Blocks);
  for(let i=0;i<4;i++){const a=spec.treatment[i*2],r=spec.treatment[i*2+1],targetBlock=await io.block(host,a,spec.label+'-cell-'+i),referenceBlock=await io.block(reference,r,spec.label+'-reference-'+i),pair=evaluatePBlockPair(targetBlock,referenceBlock,expected,t.f0.calibrationRatios[0]);
   pair.checks.bothF0CalibrationAnchors=t.f0.calibrationRatios.every(base=>Math.abs(pair.calibrationRatio/base-1)<=.10);pair.passed=Object.values(pair.checks).every(Boolean);
   t.cells.push({arm:a.arm,targetBlock,referenceBlock,pair,targetGaps:cadenceBlockGaps(targetBlock),referenceGaps:cadenceBlockGaps(referenceBlock)});await io.checkpoint(t);
  }t.result=evaluateCadenceTarget(t.cells,spec.order);await io.checkpoint(t);await io.close(host);
 }await io.close(reference);report.executionCompleted=true;report.controlsQualified=report.targets.length===2&&report.targets.every(t=>t.result.controlsQualified);report.directionalHypothesisSupported=report.controlsQualified&&report.targets.every(t=>t.result.directionalHypothesisSupported);report.ratePathSupported=report.directionalHypothesisSupported&&report.targets.every(t=>t.result.ratePathSupported);return report;
}
