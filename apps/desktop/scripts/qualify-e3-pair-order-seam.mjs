import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import inspector from 'node:inspector';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {e3InstallerSource} from './ri00/e3-install.mjs';
import {connectE3Transport} from './ri00/e3-cdp-transport.mjs';
import {createE3Journal, createE3DurableReader} from './ri00/e3-durable-reader.mjs';
import {executeCadenceBlock} from './ri00/e3-cadence-block.mjs';
import {cadenceBlockGaps} from './ri00/e3-cadence-result.mjs';
import {traceOrderBlock, executeOrderCell} from './ri00/e3-pair-order-controller.mjs';
import {compactOrderSeamCell} from './ri00/e3-pair-order-seam-record.mjs';
import {actualOrderValid} from './ri00/e3-pair-order-result.mjs';
import {pairOrderPlan} from './ri00/e3-pair-order-plan.mjs';
import {pairOrderSource} from './ri00/e3-pair-order-identity.mjs';
import {cadenceHash as hash} from './ri00/e3-cadence-identity.mjs';
const args = process.argv.slice(2), opt = k => args[args.indexOf('--' + k) + 1];
for (const k of ['output', 'tests']) if (!args.includes('--' + k)) throw Error('order_seam_inputs');
const output = opt('output'); if (fs.existsSync(output)) throw Error('order_seam_fresh_output');
const root = fileURLToPath(new URL('../../../', import.meta.url)), source = pairOrderSource(),
  candidate = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  testRaw = fs.readFileSync(opt('tests')), tests = JSON.parse(testRaw);
assert.equal(tests.passed, true); assert.equal(tests.candidate, candidate); assert.equal(tests.sourceSha256, hash(JSON.stringify(source)));
assert.equal(globalThis.__e3Owned, undefined); assert.equal(inspector.url(), undefined);
fs.mkdirSync(output, {recursive: true, mode: 0o700});
const report = {kind: 'ORDER-in-process-Node-Inspector-two-logical-host-queue-seam-not-field', candidate, source,
  testsSha256: hash(testRaw), electronLaunches: 0, dedicatedChildHosts: 0, notFieldCause: true,
  cases: [], cells: [], failures: [], passed: false}, began = performance.now(), hosts = [];
let totalReads = 0, failSync = false;
const journal = createE3Journal(path.join(output, 'journal.private.jsonl'), {maxBytes: 1048576, sync(fd) {
  if (failSync) {failSync = false; throw Error('order_seam_fsync_failure');} fs.fdatasyncSync(fd);
}}), install = Function('return (' + e3InstallerSource() + ')')();
function guard() {
  if (performance.now() - began > 25000 || totalReads > 44 || hosts.reduce((s, h) => s + h.site.probe.queueContext().controlledCpuMs, 0) > 2000)
    throw Error('order_seam_budget');
}
async function open(label) {
  const dir = path.join(output, label); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'evidence-index.jsonl'), '{}\n');
  const h = {label, failRead: false, lose: false}, store = {getStoreDir: () => dir, getPlan: () => ({}), listEvidenceIndex: () => [{}]},
    supervisor = {list() {if (++totalReads > 44) throw Error('order_seam_read_cap'); if (h.failRead) throw Error('order_seam_original_read_error');
      for (let i = 0; i < 12; i++) {store.getPlan(); store.listEvidenceIndex();} return [{}];}};
  h.store = store; h.supervisor = supervisor; h.original = {list: supervisor.list, plan: store.getPlan, index: store.listEvidenceIndex};
  h.site = install.call(store, supervisor, {workspaceId: 'order-seam'}, {longWatch: true, eventLoopReads: true,
    ownedExperiment: true, profileMarkers: true, exposureLedger: true, durationMs: 25000,
    readCpuLimitMs: 2000, queue: {owner: label, epoch: 'order-seam', allowProfileMarkers: true}});
  hosts.push(h); globalThis.__e3Owned = {...h.site, renew: () => h.site.probe.renew()};
  h.transport = await connectE3Transport(inspector.url(), {pid: process.pid, forbidProfiler: true});
  const rpc = async (method, args) => {
    if (method === 'renew') return h.site.probe.renew();
    if (method === 'takeEntries') return {entries: [], state: {metadataErrors: 0, notInstalled: true}};
    if (method === 'ackEntries') return true;
    const value = await h.transport.rpc(method, args);
    if (method === 'request' && h.lose) {h.lose = false; throw Error('order_seam_request_response_lost');} return value;
  };
  h.reader = createE3DurableReader({rpc, journal: {append(kind, value) {return journal.append(kind, {host: label, value});}}}); return h;
}
try {
  inspector.open(0, '127.0.0.1'); report.inspectorUrl = inspector.url();
  const target = await open('target'), conditioning = await open('conditioning');
  await assert.rejects(target.transport.post('Profiler.start'), /profiler_forbidden/);
  report.cases.push({name: 'Profiler-rejected-before-wire', passed: true});
  const io = {block: async (h, spec, label) => traceOrderBlock({journal, host: h.label, spec, label,
    run: () => executeCadenceBlock({read: (kind, remoteLabel) => h.reader.read(kind, remoteLabel),
      calibrate: async () => {const value = await h.transport.rpc('native'); journal.append('hash-calibration', {host: h.label, label, value}); return value;}, guard}, spec, label)})};
  for (const spec of pairOrderPlan().targets[0].cells.slice(0, 2)) {
    const cell = await executeOrderCell({io, host: target, conditioning, spec, label: 'seam-' + spec.arm});
    assert.equal(actualOrderValid(cell), true);
    for (const b of cell.executed) {assert.ok(cadenceBlockGaps(b).minimumMs >= 150); assert.ok(b.sequence.every(p => p.row.label === 'cadence-root'));}
    report.cells.push(compactOrderSeamCell(cell)); report.cases.push({name: 'complete-two-host-' + spec.arm + '-order-gap-and-hash-boundaries', passed: true});
  }
  const before = totalReads; failSync = true;
  await assert.rejects(target.reader.read('dense', 'cadence-root'), /fsync_failure/);
  assert.equal(target.reader.state().pendingArchive, true); assert.equal(target.site.queue.snapshot().ticket.state, 'completed');
  await target.reader.recoverArchive(); assert.equal(totalReads, before + 1); assert.equal(target.site.queue.snapshot().ticket, null);
  report.cases.push({name: 'fsync-failure-recover-original-before-ACK-no-replay', passed: true});
  target.lose = true; await target.reader.read('dense', 'cadence-root'); assert.equal(totalReads, before + 2);
  report.cases.push({name: 'unknown-request-query-original-id-no-replay', passed: true});
  target.failRead = true; await assert.rejects(target.reader.read('dense', 'cadence-root'), /ticket_failed/);
  target.failRead = false; await target.reader.read('dense', 'cadence-root'); assert.equal(totalReads, 44);
  report.cases.push({name: 'original-read-error-durable-and-later-admission', passed: true});
  report.actualOrderAndGapVerified = true; report.passed = true;
} catch (error) {report.failures.push({message: error.message, stack: error.stack});}
finally {
  report.recovery = [];
  for (const h of [...hosts].reverse()) {
    try {
      if (h.reader?.state().pendingArchive) await h.reader.recoverArchive();
      await h.transport?.close(); const stopped = h.site.probe.stop();
      const restored = h.store.getPlan === h.original.plan && h.store.listEvidenceIndex === h.original.index && h.supervisor.list === h.original.list;
      report.recovery.push({label: h.label, stopped, restored, transport: h.transport?.stats()});
      assert.equal(restored, true); assert.equal(stopped.restored, true); assert.equal(stopped.retainedRowBytes, 0); assert.equal(stopped.readQueue.ticket, null);
    } catch (error) {report.failures.push({message: 'recovery:' + error.message});}
  }
  inspector.close(); delete globalThis.__e3Owned; journal.close();
  report.profilerWireCommands = report.recovery.reduce((s, h) => s + Object.entries(h.transport?.wireCounts || {})
    .filter(([name]) => name.startsWith('Profiler.')).reduce((s, [, n]) => s + n, 0), 0);
  report.fixtureReads = totalReads; report.wallMs = performance.now() - began;
  if (report.failures.length || report.profilerWireCommands || report.wallMs > 30000 || report.recovery.length !== 2) report.passed = false;
  const treeBytes = dir => fs.readdirSync(dir, {withFileTypes: true}).reduce((n, e) => n + (e.isDirectory() ? treeBytes(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
  let data = JSON.stringify(report);
  if (treeBytes(output) + Buffer.byteLength(data) > 2097152) {
    report.passed = false; report.failures.push({message: 'qualification_output_budget'}); data = JSON.stringify(report);
  }
  const fd = fs.openSync(path.join(output, 'report.private.json'), 'wx', 0o600);
  try {fs.writeFileSync(fd, data); fs.fdatasyncSync(fd);} finally {fs.closeSync(fd);}
  if (!report.passed) process.exitCode = 1;
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, fixtureReads: totalReads, profilerWireCommands: report.profilerWireCommands, wallMs: report.wallMs}));
}
