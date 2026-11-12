import test from'node:test';import assert from'node:assert/strict';import{captureBudget}from'./capture-budget.mjs';
const state=()=>({restored:true,bindingRestored:true,stopped:true,metadataErrors:0,dropped:0,gcDropped:0,retainedRowBytes:0,controlledCpuMs:12000,nativeCpuMs:300,probeCpuMs:200});
const previous=()=>({kind:'persistent-dense-residual-formation-not-a-fix',longWatch:{finishedMs:6000000},ownedMain:false,synthetic:false,ok:true,failures:[],closeCheck:{closed:true},acknowledgementGapCpuMs:0,mainRuntime:{pid:10},referenceRuntime:{pid:11},epochs:[{mainA:{points:[{before:{values:{ri_proc_start_abstime:'100'}}}]}}],production:[],startedAt:'2026-11-12T00:00:00Z',finishedAt:'2026-11-12T01:40:00Z',controllerCpuMs:18000,archiveBytes:580000000,restoration:{main:state(),reference:state()},mainCpuMs:12000});
const options=()=>({previous:previous(),previousSha256:'a'.repeat(64),pid:10});
test('resource consumption carries across captures without inheriting a reference or fast baseline',()=>{
 const o=options(),r=captureBudget(o);assert.equal(r.remaining.durationMs,8400000);assert.equal(r.remaining.controllerCpuMs,12000);assert.equal(r.remaining.archiveBytes,1030612736);assert.equal(r.remaining.hosts.main.readCpuMs,48000);assert.equal(r.remaining.hosts.reference.probeCpuMs,4800);assert.equal(r.prior.noBaselineOrReferenceInherited,true);assert.equal(r.prior.mainBirth,'100');assert.equal('gate'in r.prior,false);assert.equal(o.previous.restoration.main.controlledCpuMs,12000);assert.equal(captureBudget().remaining.hosts.main.readCpuMs,60000);
});
test('known supplemental diagnostic CPU is charged and must belong to both prior hosts',()=>{
 const o=options();o.supplementalVm={scriptSha256:'b'.repeat(64),hosts:{main:{pid:10,threadUserMs:27,threadSystemMs:.5},reference:{pid:11,threadUserMs:23,threadSystemMs:.1}}};assert.equal(captureBudget(o).remaining.hosts.main.probeCpuMs,4772.5);o.supplementalVm.hosts.main.pid=99;assert.throws(()=>captureBudget(o),/supplemental_identity/);
});
test('missing restoration, unknown CPU, mismatched identity and exhausted cumulative budgets reject',()=>{
 for(const change of [o=>o.pid=20,o=>o.previous.closeCheck.closed=false,o=>o.previous.acknowledgementGapCpuMs=1,o=>o.previous.restoration.main.restored=false,o=>delete o.previous.controllerCpuMs,o=>o.previous.archiveBytes=1700000000,o=>o.previous.controllerCpuMs=29999,o=>{o.previous.mainCpuMs=o.previous.restoration.main.controlledCpuMs=21000;},o=>o.previous.longWatch.finishedMs=14400000]){const o=options();change(o);assert.throws(()=>captureBudget(o),/capture_budget_/);}
});

test('another continuation subtracts from carried limits rather than resetting the campaign',()=>{
 const first=captureBudget(options()),o=options();o.previous.campaignBudget=first;o.previous.longWatch.finishedMs=1000000;o.previous.finishedAt='2026-11-12T00:16:40Z';o.previous.controllerCpuMs=1000;o.previous.mainCpuMs=o.previous.restoration.main.controlledCpuMs=1000;o.previous.restoration.reference.controlledCpuMs=1000;o.previous.archiveBytes=0;
 const second=captureBudget(o);assert.equal(second.remaining.durationMs,7400000);assert.equal(second.remaining.controllerCpuMs,11000);assert.equal(second.remaining.hosts.main.readCpuMs,47000);
});

test('a failed observation can carry verified consumption after clean recovery, while unknown fields still reject',()=>{
 const o=options();o.previous.ok=false;o.previous.failures=['source_observer_watch_error:EIO'];assert.equal(captureBudget(o).prior.previousFailureCount,1);delete o.previous.restoration.main.probeCpuMs;assert.throws(()=>captureBudget(o),/invalid/);
});
