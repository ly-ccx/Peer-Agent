import{pBlockSchedule}from'./e3-p-reservation.mjs';
/** Frozen, non-executing action graph: only target's requested extra delay changes. */
export function cadencePlan(){
 const block=(role,arm)=>({role,arm,reads:pBlockSchedule().map(r=>({...r,waitBeforeMs:arm==='B'?0:150})),hashCalls:3});
 const targets=['ABBA','BAAB'].map((order,index)=>({label:'cadence-target-'+(index+1),order,warmRoots:8,f0:[block('target','A'),block('reference','A'),block('target','A')],treatment:[...order].flatMap(arm=>[block('target',arm),block('reference','A')])}));
 const blocks=targets.flatMap(t=>[...t.f0,...t.treatment]),warmRoots=8+targets.reduce((s,t)=>s+t.warmRoots,0),rootCount=warmRoots+blocks.reduce((s,b)=>s+b.reads.length,0),hashCalls=blocks.reduce((s,b)=>s+b.hashCalls,0),gapMs=blocks.reduce((s,b)=>s+b.reads.reduce((n,r)=>n+r.waitBeforeMs,0),0);
 return{referenceWarmRoots:8,targets,rootCount,warmRoots,blockCount:blocks.length,hashCalls,gapMs,semanticAudits:3,profileStarts:0,sameRemoteLabel:'cadence-root',noNewProductReads:true};
}
export function cadenceBudgetModel(){const p=cadencePlan(),coldRoots=3,warmRootCpuMs=750,coldRootCpuMs=3000,semanticCpuMs=500*p.semanticAudits,readForecastMs=coldRoots*coldRootCpuMs+(p.rootCount-coldRoots)*warmRootCpuMs+semanticCpuMs,hashForecastMs=p.hashCalls*50,
 wallForecastMs=readForecastMs+p.gapMs+p.hashCalls*2000+60000+20000+90000;return{rootCount:p.rootCount,coldRoots,warmRootCpuMs,coldRootCpuMs,semanticCpuMs,readForecastMs,hashForecastMs,wallForecastMs,readCpuCapMs:200000,hashCpuCapMs:4000,wallCapMs:900000,readHeadroomMs:200000-readForecastMs,hashHeadroomMs:4000-hashForecastMs,wallHeadroomMs:900000-wallForecastMs,notFutureCostGuarantee:true};}
