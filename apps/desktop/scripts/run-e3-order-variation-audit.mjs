import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditOrderF0Variation} from './ri00/e3-order-variation.mjs';
const args = process.argv.slice(2), opt = k => args[args.indexOf('--' + k) + 1];
for (const k of ['report', 'journal', 'binding', 'seal', 'output']) if (!args.includes('--' + k)) throw Error('order_variation_inputs');
const hash = b => createHash('sha256').update(b).digest('hex'), raw = fs.readFileSync(opt('report')),
  journal = fs.readFileSync(opt('journal')), bindingRaw = fs.readFileSync(opt('binding')),
  seal = JSON.parse(fs.readFileSync(opt('seal'))), report = JSON.parse(raw), binding = JSON.parse(bindingRaw);
assert.equal(hash(raw), seal.rawSha256.campaign); assert.equal(hash(journal), seal.rawSha256.journal);
assert.equal(hash(bindingRaw), report.inputs.binding);
const audit = auditOrderF0Variation(report, journal.toString().trim().split('\n').map(JSON.parse), binding.expected),
  output = {analysisCandidate: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8'}).trim(),
    originalProducer: report.candidate, inputSha256: hash(raw), journalSha256: hash(journal),
    source: ['ri00/e3-order-variation.mjs', 'ri00/e3-cadence-variation.mjs', 'ri00/e3-work-decomposition.mjs',
      'run-e3-order-variation-audit.mjs'].map(name => [name, hash(fs.readFileSync(new URL('./' + name, import.meta.url)))]), audit};
const fd = fs.openSync(opt('output'), 'wx', 0o600);
try {fs.writeFileSync(fd, JSON.stringify(output)); fs.fdatasyncSync(fd);} finally {fs.closeSync(fd);}
console.log(JSON.stringify({counts: audit.counts, rangesMs: audit.failures.map(b => b.delta.evidenceUserMs),
  rateChanges: audit.failures.map(b => b.rootWork.cpuPerCycleRelative), newProductReads: 0}));
