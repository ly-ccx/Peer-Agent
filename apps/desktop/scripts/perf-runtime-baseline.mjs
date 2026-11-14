import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { distribution, summarizeRequests, synchronizeClocks, requestPhases } from './ri00/trace.mjs';
import { contentIdentity, productionIdentity, fixtureIdentity, resolveDestination } from './ri00/identity.mjs';

const args = process.argv.slice(2);
function option(name, fallback) { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; }
const moduleRoot = path.resolve(option('--module-root', fileURLToPath(new URL('../../..', import.meta.url))));
const fixtureRoot = fs.realpathSync(option('--fixture-root', ''));
const personalRoot = path.join(os.homedir(), '.peer-agent');
const personalPath = value => value === personalRoot || value.startsWith(personalRoot + path.sep);
if (!option('--fixture-root') || personalPath(fixtureRoot)) throw new Error('explicit_isolated_fixture_required');
const output = resolveDestination(option('--output', fs.mkdtempSync(path.join(os.tmpdir(), 'peer-ri00-run-'))));
if (personalPath(output)) throw new Error('personal_output_forbidden');
if (output === fixtureRoot || output.startsWith(fixtureRoot + path.sep)) throw new Error('output_must_be_outside_fixture');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const rounds = Number(option('--rounds', '12'));
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('invalid_rounds');
if (args.includes('--expect-stall') === args.includes('--expect-responsive')) throw new Error('exactly_one_expectation_required');
if (!['bare', 'desktop'].includes(option('--bindings', 'desktop'))) throw new Error('invalid_bindings');
const config = { moduleRoot, fixtureRoot, output, parentHash: option('--parent-hash', ''),
  bindings: option('--bindings', 'desktop') === 'desktop', instrumented: args.includes('--instrumented'),
  coordinationSnapshot: option('--coordination-snapshot', null), coordinationLiveRoot: option('--readonly-coordination-root', null),
  sourcePlans: args.includes('--readonly-source-plans'), desktopDiagnostics:args.includes('--desktop-diagnostics'),
  sourceStores: args.includes('--readonly-source-stores'),
  deepBuiltins: !args.includes('--no-builtins'), instrumentPath: args.includes('--inspect-path') };
if (config.instrumentPath && !config.instrumented) throw new Error('path_observation_requires_instrumentation');
if (config.coordinationSnapshot && config.coordinationLiveRoot) throw new Error('choose_one_coordination_source');
if (config.sourcePlans && !config.coordinationLiveRoot) throw new Error('source_plans_require_readonly_source_guard');
if (config.sourceStores && !config.coordinationLiveRoot) throw new Error('source_stores_require_readonly_source_guard');
const require = createRequire(path.join(moduleRoot, 'apps/desktop/package.json'));
const { _electron } = require('playwright-core');
const configFile = path.join(output, 'config.private.json');
fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: moduleRoot, encoding: 'utf8' }).trim();
const harnessIdentity = () => ['perf-runtime-baseline.mjs', 'ri00/trace.mjs', 'ri00/identity.mjs', 'ri00/read-host.mjs', 'ri00/coordination-snapshot.mjs', 'ri00/readonly-coordination.mjs', 'ri00/gc-observation.mjs','ri00/electron-main.mjs', 'ri00/preload.cjs'].map(relative => ({ relative,
  sha256: createHash('sha256').update(fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)))).digest('hex') }));
const report = { schemaVersion: 1, kind: 'ri00-failing-baseline-not-a-fix', sourceHead,
  harness: harnessIdentity(),
  production: productionIdentity(moduleRoot), fixture: fixtureIdentity(fixtureRoot),
  snapshot: config.coordinationSnapshot ? contentIdentity(config.coordinationSnapshot) : null,
  bindings: config.bindings ? 'desktop-verification' : 'bare-supervisor', instrumented: config.instrumented,
  coordinationSnapshot: Boolean(config.coordinationSnapshot),
  coordinationLiveReadOnly: Boolean(config.coordinationLiveRoot),
  sourcePlans: config.sourcePlans,
  sourceStores: config.sourceStores,
  deepBuiltins: config.deepBuiltins, instrumentPath: config.instrumentPath,
  pairedProbe: args.includes('--paired-probe'),
  startedAt: new Date().toISOString(), attempts: [], cases: {}, limitations: [
    'Read-only host assembly; no runner, lease, model, tools or live UI-delivery adapter.',
    config.coordinationLiveRoot ? 'Production coordination reads use SQLite readOnly and a filesystem write guard; concurrent source revisions are recorded; no recovery/writer is admitted.'
      : config.coordinationSnapshot ? 'WorkBudget read port uses a consistent SQLite backup; source-token validation/recovery are not measured.' : 'No WorkBudget binding; coordination cost is excluded.',
    'Real catalog/owner/frame/origin and IPC; fixture page is not the product UI or hardware input.',
    'Burst of eight is a controlled mechanism experiment, not proof of the historical incident trigger.',
    'Unsegmented request time includes async/microtask wait; CPU self time is not inferred from it.',
  ] };
let app;
try {
  const env = { ...process.env, PEER_AGENT_HOME: fixtureRoot };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({ executablePath: require('electron'), args: [fileURLToPath(new URL('./ri00/electron-main.mjs', import.meta.url)), '--ri00-config', configFile], env, timeout: 45000 });
  await app.evaluate(async () => { while (!globalThis.ri00) await new Promise(resolve => setTimeout(resolve, 20)); });
  const page = await app.firstWindow();
  report.clockPrecision = await page.evaluate(() => {
    let last = performance.now(), quantum = Infinity;
    for (let i = 0; i < 20000; i++) { const at = performance.now(); if (at > last) quantum = Math.min(quantum, at - last); last = at; }
    return { timestampUncertaintyMs: 1, observedMinimumStepMs: Number.isFinite(quantum) ? quantum : null };
  });
  if (report.clockPrecision.observedMinimumStepMs == null || report.clockPrecision.observedMinimumStepMs > 1) throw new Error('clock_resolution_exceeds_declared_bound');
  const facts = await app.evaluate(() => ({ payload: globalThis.ri00.payload, runtime: globalThis.ri00.runtime }));
  report.runtime = facts.runtime;
  const run = async (stage, batches, concurrency = 1, delay = 20) => {
    await app.evaluate((_, stage) => globalThis.ri00.start(stage), stage);
    const client = await page.evaluate(async ({ payload, batches, concurrency, delay }) => {
      const rows = [];
      for (let round = 0; round < batches; round++) {
        rows.push(...await Promise.all(Array.from({ length: concurrency }, () => window.ri00.query(payload))));
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      return rows;
    }, { payload: facts.payload, batches, concurrency, delay });
    const main = await app.evaluate(() => globalThis.ri00.take());
    if (main.coordinationReadFailures) throw new Error('coordination_read_failure_was_swallowed_by_production_projection');
    if (client.length !== main.observations.length || client.some(row => !row.ok || row.grants !== 0)) throw new Error('request_identity_or_fixture_failed');
    if (args.includes('--expect-stall') && stage !== 'transport-control'
      && !(main.fixtureObservation.minSessions > 0)) throw new Error('fixture_session_projection_failed');
    main.observations.sort((a, b) => a.sequence - b.sequence);
    const rows = client.map((row, index) => {
      if (row.clientSequence !== main.observations[index].sequence) throw new Error('request_sequence_mismatch');
      return { ...row, ...main.observations[index], roundTripMs: row.end - row.start };
    });
    if (stage === 'transport-control') {
      report.calibrationRows = rows;
      report.clockCalibration = synchronizeClocks(rows, report.clockPrecision);
    }
    for (const row of rows) row.phases = requestPhases(row, report.clockCalibration);
    report.cases[stage] = { concurrency, batches, roundTripMs: distribution(rows.map(row => row.roundTripMs)),
      handlerSyncMs: distribution(rows.map(row => row.handlerSyncMs)), heartbeatGapMs: distribution(main.gaps),
      responseBytes: distribution(rows.map(row => row.responseBytes)), summaries: summarizeRequests(main.requests), rows, requests: main.requests };
    report.cases[stage].fixtureObservation = main.fixtureObservation;
    report.cases[stage].sourceGuard = main.sourceGuard;
    report.cases[stage].sourceRevision = main.sourceRevision;
    report.cases[stage].sourceRevisionStart = main.sourceRevisionStart;
    report.cases[stage].dependencyBindings = main.dependencyBindings;
    report.cases[stage].gc = main.gc;
    report.cases[stage].heap = {before:main.heapBefore,after:main.heapAfter,spaces:main.heapSpaces};
    for(const row of rows) row.gcMs=main.gc.reduce((sum,entry)=>sum+Math.max(0,Math.min(entry.startMono+entry.durationMs,row.enteredMain+row.handlerSyncMs)-Math.max(entry.startMono,row.enteredMain)),0);
    console.log(JSON.stringify({ stage, ...report.cases[stage].roundTripMs, handler: report.cases[stage].handlerSyncMs, mainHeartbeat: report.cases[stage].heartbeatGapMs.max }));
  };
  await run('transport-control', 25, 1, 5);
  await run('cold-query', 1);
  await run('warm-query', rounds);
  await run('burst-eight', 2, 8);
  if (report.pairedProbe) {
    if (!config.instrumented) throw new Error('paired_probe_requires_instrumentation');
    for (const [stage, enabled] of [['probe-off-A', false], ['probe-on-A', true], ['probe-on-B', true], ['probe-off-B', false]]) {
      await app.evaluate((_, enabled) => globalThis.ri00.setTrace(enabled), enabled);
      await run(stage, rounds);
    }
    const meanMedian = prefix => ['A', 'B'].reduce((sum, suffix) => sum + report.cases[`${prefix}-${suffix}`].handlerSyncMs.p50, 0) / 2;
    report.marginalProbe = { order: 'off/on/on/off; same process/data/host; root clocks and shim indirection remain',
      offMedianMs: meanMedian('probe-off'), onMedianMs: meanMedian('probe-on') };
    report.marginalProbe.deltaMs = report.marginalProbe.onMedianMs - report.marginalProbe.offMedianMs;
  }
  report.frameSamples = await page.evaluate(() => window.frameGaps);
  report.frameGapMs = distribution(report.frameSamples);
  report.budget = { maxMainGapMs: 500, violations: Object.entries(report.cases)
    .filter(([name, value]) => name !== 'transport-control' && value.heartbeatGapMs.max > 500)
    .map(([name, value]) => ({ name, observedMs: value.heartbeatGapMs.max })) };
  report.budget.passed = report.budget.violations.length === 0;
  if (args.includes('--expect-stall') && report.budget.passed) throw new Error('expected_failing_baseline_not_reproduced');
  if (args.includes('--expect-responsive') && !report.budget.passed) throw new Error('responsiveness_budget_exceeded');
  report.ok = true;
} catch (error) {
  report.ok = false;
  fs.writeFileSync(path.join(output, 'failure.private.txt'), error.stack, { mode: 0o600 });
  report.attempts.push({ outcome: 'failed', errorName: error.name, errorCode: error.code ?? null, message: error.message.slice(0, 200) });
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(error => { report.ok = false; report.cleanupFailure = error.message.slice(0, 100); process.exitCode = 1; });
  report.finishedAt = new Date().toISOString();
  report.harnessUnchangedDuringRun = JSON.stringify(report.harness) === JSON.stringify(harnessIdentity());
  if (!report.harnessUnchangedDuringRun) { report.ok = false; process.exitCode = 1; }
  try {
    report.productionUnchangedDuringRun = JSON.stringify(report.production) === JSON.stringify(productionIdentity(moduleRoot));
    report.fixtureUnchangedDuringRun = JSON.stringify(report.fixture) === JSON.stringify(fixtureIdentity(fixtureRoot));
    report.snapshotUnchangedDuringRun = !config.coordinationSnapshot
      || JSON.stringify(report.snapshot) === JSON.stringify(contentIdentity(config.coordinationSnapshot));
    if (!report.productionUnchangedDuringRun || !report.fixtureUnchangedDuringRun || !report.snapshotUnchangedDuringRun) {
      report.ok = false; report.attempts.push({ outcome: 'failed', message: 'input_changed_during_run' }); process.exitCode = 1;
    }
  } catch (error) { report.ok = false; report.identityFailure = error.message; process.exitCode = 1; }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
