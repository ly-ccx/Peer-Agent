import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditCadenceVariation} from './ri00/e3-cadence-variation.mjs';
const args = process.argv.slice(2), opt = k => args[args.indexOf('--' + k) + 1];
for (const k of ['report', 'journal', 'seal', 'output']) if (!args.includes('--' + k)) throw Error('cadence_variation_inputs');
const hash = x => createHash('sha256').update(x).digest('hex'), raw = fs.readFileSync(opt('report')),
  journalRaw = fs.readFileSync(opt('journal')), seal = JSON.parse(fs.readFileSync(opt('seal')));
if (hash(raw) !== seal.rawSha256.campaign || hash(journalRaw) !== seal.rawSha256.primaryJournal)
  throw Error('cadence_variation_sealed_input_sha_mismatch');
const report = JSON.parse(raw), journal = journalRaw.toString().trim().split('\n').map(JSON.parse),
  audit = auditCadenceVariation(report, journal), cpu = process.cpuUsage(), out = {
    analysisCandidate: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8'}).trim(),
    originalProducer: report.candidate, inputSha256: hash(raw), journalSha256: hash(journalRaw),
    sourceSha256: hash(fs.readFileSync(new URL('./ri00/e3-cadence-variation.mjs', import.meta.url))),
    cliSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), offlineProcessCpuMs: (cpu.user + cpu.system) / 1000, audit};
if (audit.counts.metricRoots !== 176 || audit.processCounterCoverage.unknownCounterRoots !== 0) throw Error('cadence_variation_complete_coverage_required');
const fd = fs.openSync(opt('output'), 'wx', 0o600);
try { fs.writeFileSync(fd, JSON.stringify(out)); fs.fdatasyncSync(fd); } finally { fs.closeSync(fd); }
console.log(JSON.stringify({rangesMs: audit.warm.map(w => w.delta.evidenceUserMs),
  AReturnsMs: audit.returns.map(r => r.delta.evidenceUserMs), joinedRoots: audit.processCounterCoverage.joinedRoots,
  offlineProcessCpuMs: out.offlineProcessCpuMs, newProductReads: 0}));
