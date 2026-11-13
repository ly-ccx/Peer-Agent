/** Prospective planning only. Cold warmups stay charged; they are not a bound on every warmed future root. */
export function planPReturnReservation({offTarget,offReference,entry,remainingReadCpuMs,remainingWallMs,remainingControllerCpuMs}){
 if(!entry?.passed) return{admitted:false,reason:'original-off-entry-not-qualified'};
 const points=[offTarget,offReference].flatMap(b=>[...(b?.markers||[]),...(b?.points||[])]);
 if(points.length!==20||points.some(p=>!Number.isFinite(p.row?.userMs)||!Number.isFinite(p.row?.systemMs)||p.row.userMs+p.row.systemMs<=0))throw Error('p_reserve_completed_equal_work_off_required');
 const maxQualifiedOffRootCpuMs=Math.max(...points.map(p=>p.row.userMs+p.row.systemMs)),perRootMs=Math.max(750,maxQualifiedOffRootCpuMs*1.5),semanticReserveMs=1500,remainingRoots=40,readReserveMs=remainingRoots*perRootMs+semanticReserveMs;
 const result={remainingRoots,maxQualifiedOffRootCpuMs,perRootMs,semanticReserveMs,readReserveMs,remainingReadCpuMs,remainingWallMs,remainingControllerCpuMs,
  basis:'completed qualified OFF block roots, including both markers and all dense points; cold warmups remain in spent CPU',notGuaranteedFutureCost:true};
 return{...result,admitted:remainingReadCpuMs>=readReserveMs&&remainingWallMs>=120000&&remainingControllerCpuMs>=5000,reason:'prospective-budget-admission-only'};
}
