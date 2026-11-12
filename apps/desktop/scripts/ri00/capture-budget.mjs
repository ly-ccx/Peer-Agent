const MAX={durationMs:14400000,controllerCpuMs:30000,archiveBytes:1610612736,hosts:{main:{readCpuMs:60000,nativeCpuMs:3000,probeCpuMs:5000},reference:{readCpuMs:60000,nativeCpuMs:3000,probeCpuMs:5000}}};
const number=(v,name)=>{if(!Number.isFinite(v)||v<0)throw Error('capture_budget_invalid:'+name);return v;};
/** Carries resource consumption only. Prior baselines/references are never returned. */
export function captureBudget({previous,previousSha256,supplementalVm,pid}={}){
 let remaining=structuredClone(MAX);if(!previous)return {remaining,prior:null};
 if(previous.campaignBudget?.remaining){const base=previous.campaignBudget.remaining;
  for(const k of ['durationMs','controllerCpuMs','archiveBytes'])if(!Number.isFinite(base[k])||base[k]<0||base[k]>MAX[k])throw Error('capture_budget_previous_limits_invalid');
  for(const host of ['main','reference'])for(const k of Object.keys(MAX.hosts[host]))if(!Number.isFinite(base.hosts?.[host]?.[k])||base.hosts[host][k]<0||base.hosts[host][k]>MAX.hosts[host][k])throw Error('capture_budget_previous_limits_invalid');
  remaining=structuredClone(base);
 }
 const p=previous;if(p.kind!=='persistent-dense-residual-formation-not-a-fix'||!p.longWatch||typeof p.longWatch!=='object'||p.ownedMain!==false||p.synthetic!==false
  ||!Array.isArray(p.failures)||p.closeCheck?.closed!==true||p.acknowledgementGapCpuMs!==0||p.mainRuntime?.pid!==pid||!/^[a-f0-9]{64}$/.test(previousSha256||''))throw Error('capture_budget_previous_receipt_rejected');
 const birth=p.mainProcessBirth??p.epochs?.[0]?.mainA?.points?.[0]?.before?.values?.ri_proc_start_abstime;
 if(!/^\d+$/.test(String(birth||''))||!Array.isArray(p.production))throw Error('capture_budget_previous_identity_required');
 const wall=Date.parse(p.finishedAt)-Date.parse(p.startedAt),observed=Math.max(number(wall,'wall'),number(p.longWatch.finishedMs,'observed'));
 remaining.durationMs-=observed;remaining.controllerCpuMs-=number(p.controllerCpuMs,'controller');remaining.archiveBytes-=number(p.archiveBytes,'archive');
 for(const host of ['main','reference']){
  const s=p.restoration?.[host];if(s?.restored!==true||s.bindingRestored!==true||s.stopped!==true||s.metadataErrors!==0||s.dropped!==0||s.gcDropped!==0||s.retainedRowBytes!==0)throw Error('capture_budget_previous_restoration_required');
  const cost={readCpuMs:number(s.controlledCpuMs,host+'.read'),nativeCpuMs:number(s.nativeCpuMs,host+'.native'),probeCpuMs:number(s.probeCpuMs,host+'.probe')};
  if(supplementalVm){const vm=supplementalVm.hosts?.[host];if(vm?.pid!==p[host+'Runtime']?.pid||!/^[a-f0-9]{64}$/.test(supplementalVm.scriptSha256||''))throw Error('capture_budget_supplemental_identity_rejected');cost.probeCpuMs+=number(vm.threadUserMs,host+'.extraUser')+number(vm.threadSystemMs,host+'.extraSystem');}
  for(const k of Object.keys(cost))remaining.hosts[host][k]-=cost[k];
 }
 if(Math.abs(p.mainCpuMs-p.restoration.main.controlledCpuMs)>.001)throw Error('capture_budget_previous_cpu_gap');
 remaining.durationMs=Math.floor(remaining.durationMs);
 if(remaining.durationMs<900000||remaining.controllerCpuMs<1000||remaining.archiveBytes<0||remaining.hosts.main.readCpuMs<40000
  ||Object.values(remaining.hosts).some(h=>h.readCpuMs<=0||h.nativeCpuMs<100||h.probeCpuMs<100))throw Error('capture_budget_remaining_insufficient');
 return {remaining,prior:{receiptSha256:previousSha256,mainPid:pid,mainBirth:String(birth),production:p.production,observedMs:observed,supplementalIncluded:Boolean(supplementalVm),previousMechanicsOk:p.ok===true,previousFailureCount:p.failures.length,resourceConsumptionOnly:true,noBaselineOrReferenceInherited:true}};
}
