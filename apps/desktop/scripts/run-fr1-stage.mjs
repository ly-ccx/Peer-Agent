import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {startOwnedE3Host} from './ri00/e3-owned-host.mjs';
import {connectFr1Transport} from './ri00/fr1-transport.mjs';
import {installFr1Session,stopFr1Session,FR1_NOTICE} from './ri00/fr1-session.mjs';
import {fr1InstallDeclaration} from './ri00/fr1-install.mjs';
import {discoverE3Entries} from './ri00/e3-entry-discovery.mjs';
import {createFr1Journal,replayFr1Journal} from './ri00/fr1-journal.mjs';
import {createFr1StageMeter} from './ri00/fr1-stage-meter.mjs';
import {fr1StageDeclaration} from './ri00/fr1-stage-source.mjs';
import {fr1StageIdentity} from './ri00/fr1-stage-identity.mjs';
import {analyzeFr1Stages} from './ri00/fr1-stage-analysis.mjs';
import {fr1Hash as hash} from './ri00/fr1-identity.mjs';
import {productionIdentity} from './ri00/identity.mjs';
import {verifyCadenceFixture} from './ri00/e3-cadence-identity.mjs';
import {inspectClosure} from './ri00/trace.mjs';

const args=process.argv.slice(2),opt=k=>args[args.indexOf('--'+k)+1];
for(const k of ['config','budget','tests','baseline','manifest','output'])if(!args.includes('--'+k))throw Error('stage_inputs');
const read=k=>JSON.parse(fs.readFileSync(opt(k))),config=read('config'),budget=read('budget'),tests=read('tests'),baseline=read('baseline');
const repo=fileURLToPath(new URL('../../../',import.meta.url)),output=path.resolve(opt('output')),started=performance.now();
const candidate=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),source=fr1StageIdentity(),generated=fr1StageDeclaration();
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(),'');
assert.equal(tests.candidate,candidate);assert.equal(tests.passed,true);assert.equal(tests.sourceSha256,hash(JSON.stringify(source)));
assert.equal(tests.generatedSha256,generated.generatedSha256);assert.equal(tests.configSha256,hash(fs.readFileSync(opt('config'))));
assert.equal(budget.baseCandidate,'63bd98bd8ae04b34d9112d1b4f92a5fa0cd53a24');
assert.equal(budget.ownedElectronLaunches,1);assert.equal(budget.replacements,0);assert.equal(budget.businessQueriesMaximum,2);
assert.equal(budget.perRootConservativeChargeMsUnchanged,2);assert.equal(budget.totalProbeChargeMsUnchanged,3000);
assert.deepEqual(productionIdentity(config.moduleRoot),baseline.production);
const fixture=verifyCadenceFixture(config.fixtureRoot,read('manifest'),baseline.inputManifest.sha256);
if(fs.existsSync(output))throw Error('stage_fresh_output');fs.mkdirSync(output,{recursive:true,mode:0o700});
const owner='fr1-stage-'+randomUUID(),report={kind:'FR1-real-Electron-stages-not-qualification',candidate,source,
  baseFunctionSha256:generated.baseFunctionSha256,generatedSha256:generated.generatedSha256,seams:generated.seams,
  inputs:Object.fromEntries(['config','budget','tests','baseline','manifest'].map(k=>[k,hash(fs.readFileSync(opt(k)))])),fixture,
  historicalChargeMs:2.387122999994517,historicalChargeNotReconstructed:true,ownedLaunches:0,businessQueries:0,
  actualPeerAttachments:0,actualPeerBusinessQueries:0,actualPeerRestarts:0,profilerStarts:0,
  functionalQualification:false,fieldAdmission:false,RI00Closed:false,refactorStarted:false,failures:[]};
let host,transport,journal,recovery;
function save(){fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report),{mode:0o600});}
const remaining=()=>performance.now()-started<23000;
try{
  report.ownedLaunches=1;save();
  host=await startOwnedE3Host({...config,mode:'production',fr1Functional:true,output:path.join(output,'host'),label:'fr1-stage',inspect:true,defaultVm:true},
    {entrypoint:new URL('./ri00/fr1-stage-owned-main.cjs',import.meta.url)});
  report.runtime=host.ready.runtime;assert.equal(report.runtime.electron,'41.7.1');assert.equal(report.runtime.node,'24.15.0');
  assert.ok(host.ready.bootstrapReadCpuMs<=budget.readCpuMsMaximum);report.businessQueries=1;
  if(!remaining())throw Error('stage_admission_deadline');
  transport=await connectFr1Transport(host.ready.inspectorUrl,{pid:host.child.pid});
  const refs=await discoverE3Entries(transport.post,{electronRequireBase:path.join(config.moduleRoot,'apps/desktop/package.json')});report.mapping=refs.proof;
  await transport.evaluate(`(()=>{if(!globalThis.__fr1OwnedChecks||Object.hasOwn(globalThis,'__fr1StageMeter'))throw Error('stage_owned_marker');globalThis.__fr1StageMeter=(${createFr1StageMeter.toString()})({owner:${JSON.stringify(owner)}});return true;})()`);
  const adapted=Object.create(transport);let substitutions=0;
  adapted.post=(method,params)=>{
    if(method==='Runtime.callFunctionOn'&&params.functionDeclaration===fr1InstallDeclaration()){
      if(++substitutions!==1)throw Error('stage_install_once');params={...params,functionDeclaration:generated.declaration};
    }
    return transport.post(method,params);
  };
  report.initial=await installFr1Session(adapted,refs,{ownerId:owner,expectedWorkspaceId:host.ready.scopeWorkspace,epoch:'sealed-stage-input',identityComplete:true,
    durationMs:25000,leaseMs:25000,ownedFunctional:true,electronRequireBase:path.join(config.moduleRoot,'apps/desktop/package.json')});
  assert.equal(substitutions,1);journal=createFr1Journal(path.join(output,'history.private.jsonl'),{maxBytes:budget.journalBytesMaximum});
  report.transparency=await host.rpc('checks');assert.equal(report.transparency.sameError,true);assert.equal(report.transparency.samePromise,true);
  if(!remaining())throw Error('stage_admission_deadline');
  report.query=await host.rpc('entry',{kind:'list-sessions'});assert.equal(report.query.ok,true);report.businessQueries=2;
  recovery=await stopFr1Session(transport,journal,{ownerId:owner});report.recovery=recovery;
  const meter=await transport.evaluate('globalThis.__fr1StageMeter.freeze()');
  const meterText=JSON.stringify(meter);assert.ok(Buffer.byteLength(meterText)<=budget.stageSnapshotBytesMaximum);
  fs.writeFileSync(path.join(output,'stages.private.json'),meterText,{mode:0o600});report.stageSnapshotSha256=hash(meterText);
  const history=replayFr1Journal(fs.readFileSync(path.join(output,'history.private.jsonl'),'utf8')),roots=history.records.filter(x=>x.kind==='root');
  assert.equal(roots.length,1);const root=roots[0].value;assert.equal(root.rows,baseline.expected.sessions);assert.equal(root.planCalls,baseline.expected.planCalls);
  assert.equal(root.outputSha256,baseline.expected.outputSha256);assert.equal(root.evidence.length,12);assert.ok(root.evidence.every(e=>e.rows===baseline.expected.evidenceRows&&!e.readFailure));
  report.root=root;report.finalRecorder=recovery.state;report.history={...history,records:history.records.length};
  report.analysis=analyzeFr1Stages(meter,root,recovery.state);report.measurementComplete=report.analysis.valid;
  report.originalGatePassed=recovery.state.lastRootSelfCpuMs<=2;
  if(!report.analysis.valid)report.failures.push({message:'stage_measurement_invalid',details:report.analysis.errors});
  if(!remaining())throw Error('stage_clock_control_admission_deadline');
  report.clockControl=await transport.evaluate('globalThis.__fr1StageMeter.clockControl()');assert.equal(report.clockControl.pairs.length,64);
  if(!report.clockControl.withinBudget)throw Error('stage_clock_control_budget');
}catch(error){report.failures.push({message:error.message,stack:error.stack});}
finally{
  if(transport?.recorderId&&!recovery&&journal)try{report.recovery=await stopFr1Session(transport,journal,{ownerId:owner});}catch(error){report.failures.push({message:'stage_cleanup:'+error.message});}
  if(transport){
    try{await transport.post('Runtime.removeBinding',{name:FR1_NOTICE});}catch(error){report.failures.push({message:'stage_binding_cleanup:'+error.message});}
    try{await transport.evaluate(`(()=>{const d=globalThis.__fr1StageMeter;if(d?.owner===${JSON.stringify(owner)})delete globalThis.__fr1StageMeter;return true;})()`);}catch(error){report.failures.push({message:'stage_meter_cleanup:'+error.message});}
    try{await transport.close();}catch(error){report.failures.push({message:'stage_transport_close:'+error.message});}
  }
  if(host)try{
    report.exit=await host.close();report.closed=await host.closed;report.portClosure=await inspectClosure(new URL(host.ready.inspectorUrl).port,{timeoutMs:1000});
    assert.equal(report.closed.code,0);assert.equal(report.portClosure.closed,true);assert.ok(Object.values(report.exit.owners).every(Boolean));
    assert.equal(report.exit.queryCalls,2);assert.ok(report.exit.readCpuMs<=budget.readCpuMsMaximum);assert.ok(Object.values(report.exit.getters).every(x=>x===0));assert.equal(report.exit.guard.sourceWritesDenied,0);
  }catch(error){report.failures.push({message:'stage_exit:'+error.message});}
  journal?.close();report.wallMs=performance.now()-started;report.functionalQualification=false;report.fieldAdmission=false;
  if(report.wallMs>budget.wallMsIncludingCleanup)report.failures.push({message:'stage_wall_budget'});
  save();process.exitCode=report.failures.length||!report.measurementComplete||!report.originalGatePassed?1:0;
  console.log(JSON.stringify({measurementComplete:report.measurementComplete??false,originalGatePassed:report.originalGatePassed??false,
    diagnosticChargeMs:report.finalRecorder?.lastRootSelfCpuMs,recordedRoots:report.finalRecorder?.roots,queries:report.exit?.queryCalls,
    recovered:report.recovery?.restored,wallMs:report.wallMs,failures:report.failures.map(x=>x.message),functionalQualification:false,fieldAdmission:false}));
}
