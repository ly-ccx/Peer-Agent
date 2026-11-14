import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startOwnedE3Host} from './ri00/e3-owned-host.mjs';
import {fr1Source,fr1Hash as hash} from './ri00/fr1-identity.mjs';
import {productionIdentity} from './ri00/identity.mjs';
import {verifyCadenceFixture} from './ri00/e3-cadence-identity.mjs';
import {replayFr1Stages} from './ri00/fr1-stage-replay.mjs';
import {partitionFr1StageGaps} from './ri00/fr1-stage-gaps.mjs';
import {fr1MetadataEvents} from './ri00/fr1-observer-controls.mjs';

export function observerSource(){return fr1Source().concat([['run-fr1-observer-controls.mjs',hash(fs.readFileSync(fileURLToPath(import.meta.url)))]]);}
export function bindObserverInputs(files){
  const text=Object.fromEntries(Object.entries(files).map(([k,f])=>[k,fs.readFileSync(f)])),read=k=>JSON.parse(text[k]);
  const old=read('oldReport'),meter=read('stages'),budget=read('budget'),config=read('config'),baseline=read('baseline');
  assert.equal(old.candidate,budget.producerOfSealedInput);assert.equal(hash(text.stages),old.stageSnapshotSha256);
  replayFr1Stages(old,meter,text.history.toString());
  for(const [n,wanted]of old.source){let url=new URL('./ri00/'+n,import.meta.url);if(!fs.existsSync(url))url=new URL('./'+n,import.meta.url);assert.equal(hash(fs.readFileSync(url)),wanted,'sealed producer file '+n);}
  const gaps=partitionFr1StageGaps(meter,old.root,old.finalRecorder);assert.equal(gaps.buckets[0].totalUs,259);assert.equal(gaps.buckets[1].totalUs,428);
  assert.deepEqual(budget.sequencePerFamily,['A','B','B','A','B','A','A','B']);assert.equal(budget.ownedElectronLaunches,1);assert.equal(budget.replacements,0);
  assert.equal(budget.cellCpuMsMaximum,2);assert.equal(budget.originalRecorderPerRootChargeMsUnchanged,2);assert.equal(budget.originalRecorderTotalChargeMsUnchanged,3000);
  assert.equal(budget.businessQueriesMaximum,1);assert.equal(budget.recorderInstallations,0);
  assert.deepEqual(productionIdentity(config.moduleRoot),baseline.production);
  const fixture=verifyCadenceFixture(config.fixtureRoot,read('manifest'),baseline.inputManifest.sha256);
  return{config,budget,baseline,fixture,events:fr1MetadataEvents(meter,old.root,old.finalRecorder),gaps,
    expected:{...baseline.expected,outputBytes:old.root.outputBytes},inputs:Object.fromEntries(Object.entries(text).map(([k,v])=>[k,hash(v)]))};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),opt=k=>args[args.indexOf('--'+k)+1];
  const names=['config','budget','oldReport','stages','history','baseline','manifest'];for(const k of [...names,'tests','output'])assert.ok(args.includes('--'+k),k);
  const repo=fileURLToPath(new URL('../../../',import.meta.url)),candidate=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
  assert.equal(execFileSync('git',['status','--porcelain'],{cwd:repo,encoding:'utf8'}).trim(),'');
  const source=observerSource(),files=Object.fromEntries(names.map(k=>[k,opt(k)])),tests=JSON.parse(fs.readFileSync(opt('tests'))),binding=bindObserverInputs(files);
  assert.equal(tests.candidate,candidate);assert.equal(tests.passed,true);assert.equal(tests.sourceSha256,hash(JSON.stringify(source)));assert.deepEqual(tests.inputs,binding.inputs);
  const output=path.resolve(opt('output'));assert.equal(fs.existsSync(output),false);fs.mkdirSync(output,{mode:0o700});
  const report={candidate,source,inputs:binding.inputs,testsSha256:hash(fs.readFileSync(opt('tests'))),fixture:binding.fixture,
    kind:'FR1-owned-Electron-observer-controls-not-qualification',ownedLaunches:0,failures:[],actualPeerAttachments:0,actualPeerRestarts:0,
    functionalQualification:false,fieldAdmission:false,RI00Closed:false,refactorStarted:false};
  const started=performance.now();let host;
  try{
    report.ownedLaunches=1;fs.writeFileSync(path.join(output,'launch-intent.private.json'),JSON.stringify(report),{flag:'wx',mode:0o600});
    host=await startOwnedE3Host({...binding.config,output:path.join(output,'host'),fr1ObserverControl:true,defaultVm:true,inspect:false,
      budget:binding.budget,events:binding.events,expected:binding.expected},{entrypoint:new URL('./ri00/fr1-observer-owned-main.cjs',import.meta.url)});
    report.ready=host.ready;assert.equal(host.ready.runtime.electron,'41.7.1');assert.equal(host.ready.runtime.node,'24.15.0');assert.equal(host.ready.inspectorUrl,null);
    if(performance.now()-started>=23000)throw Error('observer_parent_admission_deadline');
    report.controls=await host.rpc('run');if(!report.controls.completed)report.failures.push(report.controls.stopReason??'controls-incomplete');
  }catch(e){report.failures.push(e.message);}
  finally{
    if(host)try{report.exit=await host.close();report.closed=await host.closed;assert.equal(report.closed.code,0);
      assert.equal(report.exit.queryCalls,1);assert.ok(report.exit.readCpuMs<=binding.budget.readCpuMsMaximum);assert.equal(report.exit.inspectorOpen,false);
      assert.equal(report.exit.privateValueReleased,true);assert.ok(Object.values(report.exit.getters).every(x=>x===0));assert.equal(report.exit.guard.sourceWritesDenied,0);
    }catch(e){report.failures.push('cleanup:'+e.message);}
    try{const after=bindObserverInputs(files);assert.deepEqual(after.inputs,binding.inputs);assert.deepEqual(observerSource(),source);report.sourceDataUnchanged=true;}catch(e){report.failures.push('post-binding:'+e.message);}
    report.wallMs=performance.now()-started;if(report.wallMs>30000)report.failures.push('wall-cap');
    const bytes=dir=>fs.readdirSync(dir,{withFileTypes:true}).reduce((n,e)=>{const f=path.join(dir,e.name);return n+(e.isDirectory()?bytes(f):e.isFile()?fs.statSync(f).size:0);},0);
    report.outputBytesBeforeReport=bytes(output);const text=JSON.stringify(report);if(report.outputBytesBeforeReport+Buffer.byteLength(text)>binding.budget.totalOutputBytesMaximum)report.failures.push('total-output-cap');
    fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(report),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({candidate,completed:report.controls?.completed??false,cells:report.controls?.rows.length??0,contrasts:report.controls?.contrasts,
      controlCpuMs:report.controls?.cpuMs,readCpuMs:report.exit?.readCpuMs,wallMs:report.wallMs,failures:report.failures,functionalQualification:false,fieldAdmission:false}));
    process.exitCode=report.failures.length?1:0;
  }
}
