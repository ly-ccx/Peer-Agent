import fs from 'node:fs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cadenceHash as hash,verifyCadenceFixture} from './ri00/e3-cadence-identity.mjs';
import {placementSource} from './ri00/e3-calibration-placement-identity.mjs';
import {calibrationPlacementPlan,calibrationPlacementBudgetModel} from './ri00/e3-calibration-placement-plan.mjs';
import {productionIdentity} from './ri00/identity.mjs';
const args=process.argv.slice(2),opt=k=>args[args.indexOf('--'+k)+1],inputs=['config','budget','baseline','parent','parent-journal','audit','design','seal','manifest','seam','seam-cost','tests'];
for(const k of [...inputs,'output'])if(!args.includes('--'+k))throw Error('placement_binding_inputs');
const read=k=>JSON.parse(fs.readFileSync(opt(k))),root=fileURLToPath(new URL('../../../',import.meta.url)),candidate=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),'','placement_dirty_candidate');
const config=read('config'),budget=read('budget'),baseline=read('baseline'),parent=read('parent'),audit=read('audit'),seal=read('seal'),tests=read('tests'),seam=read('seam'),cost=read('seam-cost'),source=placementSource();
assert.equal(budget.kind,'E3-HASH-PLACEMENT-warm-gate-diagnostic-design-frozen-not-executed');
assert.equal(budget.electronLaunches,3);assert.equal(budget.replacements,0);assert.equal(budget.profileStarts,0);
assert.equal(hash(fs.readFileSync(opt('parent'))),budget.parentReportSha256);assert.equal(hash(fs.readFileSync(opt('parent-journal'))),budget.parentJournalSha256);
assert.equal(seal.rawSha256.campaign,budget.parentReportSha256);assert.equal(seal.rawSha256.journal,budget.parentJournalSha256);
assert.equal(hash(fs.readFileSync(opt('audit'))),budget.parentAuditSha256);assert.equal(audit.inputSha256,budget.parentReportSha256);assert.equal(audit.journalSha256,budget.parentJournalSha256);
assert.equal(hash(fs.readFileSync(opt('design'))),budget.actionGraphAndModelSha256);
assert.deepEqual(read('design'),{plan:calibrationPlacementPlan(),model:calibrationPlacementBudgetModel(),executed:false});
assert.equal(hash(fs.readFileSync(new URL('./ri00/e3-calibration-placement-plan.mjs',import.meta.url))),budget.planSourceSha256);
assert.deepEqual(budget.resourceModel,calibrationPlacementBudgetModel());assert.equal(budget.rootsMaximum,184);assert.equal(budget.nativeCallsMaximum,57);
assert.equal(tests.passed,true);assert.equal(tests.candidate,candidate);assert.equal(tests.sourceSha256,hash(JSON.stringify(source)));
assert.equal(seam.testsSha256,hash(fs.readFileSync(opt('tests'))));assert.equal(seam.passed,true);assert.equal(seam.candidate,candidate);assert.deepEqual(seam.source,source);
assert.equal(seam.electronLaunches,0);assert.equal(seam.dedicatedChildHosts,0);assert.equal(seam.profilerWireCommands,0);assert.equal(seam.fixtureReads,44);
assert.equal(seam.exactCalibrationPlacementVerified,true);assert.equal(seam.actualOrderAndGapVerified,true);assert.equal(seam.nativeCallsExecuted,19);assert.equal(seam.nativeRpcAttempts,20);
assert.equal(seam.inspectorClosed,true);assert.equal(seam.originalGlobalRestored,true);assert.equal(cost.portRefused,true);
assert.equal(cost.exitCode,0);assert.equal(cost.reportSha256,hash(fs.readFileSync(opt('seam'))));assert.equal(cost.outputBudgetPassed,true);
assert.ok(cost.outputBytes<=2097152&&cost.fullChildSubtreeCpuMs>0&&cost.wallMsThroughReap<=30000);
assert.deepEqual(productionIdentity(config.moduleRoot),baseline.production);assert.deepEqual(parent.production,baseline.production);
assert.equal(hash(JSON.stringify(baseline.production)),budget.data.productionIdentitySha256);assert.deepEqual(baseline.expected,budget.data.expected);
assert.equal(baseline.evidenceSemanticSha256,budget.data.evidenceSemanticSha256);assert.equal(baseline.inputManifest.sha256,budget.data.fixtureManifestSha256);
const copy=verifyCadenceFixture(config.fixtureRoot,read('manifest'),budget.data.fixtureManifestSha256), result={kind:'HASH-PLACEMENT-same-candidate-seam-and-data-binding',candidate,source,
 inputs:Object.fromEntries(inputs.map(k=>[k,hash(fs.readFileSync(opt(k)))])),copy,production:baseline.production,expected:baseline.expected,evidenceSemanticSha256:baseline.evidenceSemanticSha256,
 scope:{fixtureOnly:true,actualPeerAttached:false,profilerAllowed:false,diagnosticOnly:true,fieldWindowAllowed:false},passed:true};
const fd=fs.openSync(opt('output'),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(result));fs.fdatasyncSync(fd);}finally{fs.closeSync(fd);}
console.log(JSON.stringify({passed:true,candidate,files:copy.files,fences:copy.fences}));
