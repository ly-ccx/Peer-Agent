export function pBlockSchedule(){return[{kind:'clock-start',suffix:'start',waitBeforeMs:150},...Array.from({length:8},(_,i)=>({kind:'dense',suffix:String(i),waitBeforeMs:150})),{kind:'clock-end',suffix:'end',waitBeforeMs:150}];}
export function pReturnSchedule(){return['ON-target','ON-reference','OFF-return-target','OFF-return-reference'].map(role=>({role,reads:pBlockSchedule(),hashCalls:3}));}
/** Prospective planning only. Cold warmups stay charged; they are not a bound on every warmed future root. */
export function planPReturnReservation({offTarget,offReference,entry,remainingReadCpuMs,remainingWallMs,remainingControllerCpuMs,remainingHashCpuMs}){
 if(!entry?.passed) return{admitted:false,reason:'original-off-entry-not-qualified'};
 const points=[offTarget,offReference].flatMap(b=>[...(b?.markers||[]),...(b?.points||[])]);
 if(points.length!==20||points.some(p=>!Number.isFinite(p.row?.userMs)||!Number.isFinite(p.row?.systemMs)||p.row.userMs+p.row.systemMs<=0))throw Error('p_reserve_completed_equal_work_off_required');
 const work=pReturnSchedule(),remainingRoots=work.reduce((s,b)=>s+b.reads.length,0),remainingHashCalls=work.reduce((s,b)=>s+b.hashCalls,0),gapReserveMs=work.reduce((s,b)=>s+b.reads.reduce((n,r)=>n+r.waitBeforeMs,0),0);
 const maxQualifiedOffRootCpuMs=Math.max(...points.map(p=>p.row.userMs+p.row.systemMs)),perRootMs=Math.max(750,maxQualifiedOffRootCpuMs*1.5),semanticReserveMs=1500,readReserveMs=remainingRoots*perRootMs+semanticReserveMs;
 const walls=points.map(p=>p.row.end-p.row.start);if(walls.some(w=>!Number.isFinite(w)||w<0))throw Error('p_reserve_read_wall_required');
 const perRootWallMs=Math.max(perRootMs,...walls.map(w=>w*1.5)),readWallReserveMs=remainingRoots*perRootWallMs+semanticReserveMs;
 const hashes=[offTarget,offReference].flatMap(b=>b.calibration||[]);if(hashes.length!==6||hashes.some(h=>!Number.isFinite(h.userMs+h.systemMs)||h.userMs+h.systemMs<=0))throw Error('p_reserve_completed_hashes_required');
 const hashCpuReserveMs=remainingHashCalls*Math.max(100,...hashes.map(h=>(h.userMs+h.systemMs)*1.5));
 const cleanupReserveMs=90000,controllerWallReserveMs=5000,profileControllerWallReserveMs=30000,hashWallReserveMs=remainingHashCalls*2000,wallReserveMs=cleanupReserveMs+readWallReserveMs+gapReserveMs+controllerWallReserveMs+profileControllerWallReserveMs+hashWallReserveMs;
 const result={remainingRoots,remainingHashCalls,maxQualifiedOffRootCpuMs,perRootMs,perRootWallMs,semanticReserveMs,readReserveMs,readWallReserveMs,hashCpuReserveMs,remainingReadCpuMs,remainingHashCpuMs,remainingWallMs,remainingControllerCpuMs,cleanupReserveMs,gapReserveMs,controllerWallReserveMs,profileControllerWallReserveMs,hashWallReserveMs,wallReserveMs,
  basis:'completed qualified OFF block roots, including both markers and all dense points; cold warmups remain in spent CPU',notGuaranteedFutureCost:true};
 return{...result,admitted:remainingReadCpuMs>=readReserveMs&&remainingHashCpuMs>=hashCpuReserveMs&&remainingWallMs>=wallReserveMs&&remainingControllerCpuMs>=5000,reason:'prospective-budget-admission-only'};
}
