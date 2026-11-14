import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn,execFileSync } from 'node:child_process';
import { fixtureIdentity,resolveDestination,productionIdentity,contentIdentity } from './ri00/identity.mjs';

const args=process.argv.slice(2),option=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const moduleRoot=path.resolve(option('--module-root',fileURLToPath(new URL('../../..',import.meta.url))));
if(!option('--fixture-root')||!option('--output'))throw new Error('explicit_fixture_and_output_required');
const fixtureRoot=fs.realpathSync(option('--fixture-root')),output=resolveDestination(option('--output'));
const personal=resolveDestination(path.join(os.homedir(),'.peer-agent'));
for(const root of [fixtureRoot,output])if(root===personal||root.startsWith(personal+path.sep))throw new Error('isolated_paths_required');
if(output===fixtureRoot||output.startsWith(fixtureRoot+path.sep)||fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('new_output_outside_fixture_required');
const factor=option('--factor','sham'),layout=option('--layout','workspace'),target=option('--target','pipeline'),prelude=option('--prelude','none');
if(!['sham','dictionary-shapes','frozen-shapes','retained-heap','retain-normalized','writer-shapes','evidence-merge-replay','mutate-normalized','string-coercion','idle-cadence','full-host','diagnostic-hooks','host-observation','cpu-profile','scope-inspection','array-species','regexp-exec','array-prototype-element'].includes(factor))throw new Error('invalid_factor');
if(!['pipeline','evidence-read','store','host'].includes(target))throw new Error('invalid_target');
if(!['none','desktop-preview','full-host','retain-normalized','writer-shapes','evidence-merge-replay'].includes(prelude))throw new Error('invalid_prelude');
if(!['workspace','installed'].includes(layout)||layout==='installed'&&!option('--installed-root'))throw new Error('invalid_module_layout');
if((factor==='full-host'||target==='host'||prelude==='full-host')&&!option('--coordination-snapshot'))throw new Error('full_host_requires_fixed_coordination_snapshot');
if((factor==='host-observation'&&target!=='host')||((target==='host'||prelude==='full-host')&&layout!=='workspace'))throw new Error('invalid_host_experiment');
const config={moduleRoot,fixtureRoot,output,factor,layout,target,prelude,installedRoot:option('--installed-root'),
  coordinationSnapshot:option('--coordination-snapshot'),parentHash:option('--parent-hash',''),
  batches:Number(option('--batches','7')),warmReads:Number(option('--warm-reads','12')),readsPerBatch:target==='host'?1:12,
  retainedMiB:Number(option('--retained-mib','128')),idleMs:Number(option('--idle-ms','1000')),calibrationAfter:args.includes('--calibration-after'),replicate:Number(option('--replicate','1'))};
if(!Number.isInteger(config.batches)||config.batches<3||config.batches>30||!Number.isInteger(config.warmReads)||config.warmReads<0||config.warmReads>120
  ||!Number.isInteger(config.retainedMiB)||config.retainedMiB<0||config.retainedMiB>512||!Number.isInteger(config.idleMs)||config.idleMs<20||config.idleMs>15000)throw new Error('unbounded_experiment');
fs.mkdirSync(output,{recursive:true,mode:0o700});fs.chmodSync(output,0o700);
const harnessFiles=['perf-normalization-isolation.mjs','ri00/normalization-lab.mjs','ri00/live-observation.mjs','ri00/readonly-coordination.mjs','ri00/read-host.mjs','ri00/trace.mjs','ri00/identity.mjs','ri00/coordination-snapshot.mjs'];
const harness=()=>harnessFiles.map(relative=>({relative,sha256:createHash('sha256').update(fs.readFileSync(new URL(relative,import.meta.url))).digest('hex')}));
const production=()=>[...productionIdentity(moduleRoot),{relative:'packages/protocol/dist',...contentIdentity(path.join(moduleRoot,'packages/protocol/dist'))}];
const envelope={kind:'isolated-normalization-lab-not-a-fix',startedAt:new Date().toISOString(),harness:harness(),fixture:fixtureIdentity(fixtureRoot),
  sourceHead:execFileSync('git',['rev-parse','HEAD'],{cwd:moduleRoot,encoding:'utf8'}).trim(),failures:[],criteria:{candidateCpuRatio:1.15,candidateBatchCpuIncreaseMs:40,confirmation:'At least 3 fresh matched treatment/sham repetitions; unchanged data/output/code; calibration and GC accounted; then repeat in real read-host seam.'}};
const snapshotHash=()=>config.coordinationSnapshot?createHash('sha256').update(fs.readFileSync(config.coordinationSnapshot)).digest('hex'):null;
envelope.snapshotSha256=snapshotHash();
envelope.production=production();
const require=createRequire(path.join(moduleRoot,'apps/desktop/package.json'));
const file=path.join(output,'fixture.private.cjs'),result=path.join(output,'child.private.json');
fs.writeFileSync(file,`const{app}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(output,'user-data'))});
process.env.PEER_AGENT_HOME=${JSON.stringify(fixtureRoot)};process.env.PEER_AGENT_SLOW_TIMER_MS='0';
app.whenReady().then(async()=>{const{runNormalizationLab}=await import(${JSON.stringify(new URL('./ri00/normalization-lab.mjs',import.meta.url).href)});
const report=await runNormalizationLab(${JSON.stringify(config)});fs.writeFileSync(${JSON.stringify(result)},JSON.stringify(report,null,2),{mode:0o600});app.exit(report.ok?0:1);})
.catch(error=>{fs.writeFileSync(${JSON.stringify(path.join(output,'failure.private.txt'))},error.stack);app.exit(1)});`,{mode:0o600});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(require('electron'),[file],{env,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes;});
const watchdog=setTimeout(()=>child.kill('SIGTERM'),180000);let code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(watchdog);
fs.writeFileSync(path.join(output,'child-stderr.private.txt'),stderr,{mode:0o600});
envelope.child=fs.existsSync(result)?JSON.parse(fs.readFileSync(result,'utf8')):null;
envelope.harnessUnchanged=JSON.stringify(harness())===JSON.stringify(envelope.harness);
envelope.fixtureUnchanged=JSON.stringify(fixtureIdentity(fixtureRoot))===JSON.stringify(envelope.fixture);
envelope.snapshotUnchanged=snapshotHash()===envelope.snapshotSha256;
envelope.productionUnchanged=JSON.stringify(production())===JSON.stringify(envelope.production);
envelope.ok=code===0&&envelope.child?.ok&&envelope.harnessUnchanged&&envelope.fixtureUnchanged&&envelope.snapshotUnchanged&&envelope.productionUnchanged;
envelope.finishedAt=new Date().toISOString();
fs.writeFileSync(path.join(output,'report.private.json'),JSON.stringify(envelope,null,2),{mode:0o600});
console.log(JSON.stringify({ok:envelope.ok,factor,layout,target,prelude,summaries:envelope.child?.phases.map(phase=>({phase:phase.name,...phase.summary})),failures:envelope.child?.failures.map(({name,code})=>({name,code}))}));
if(!envelope.ok)process.exitCode=1;
