import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function sourceFingerprint(root) {
  const files = [...new Set(execFileSync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  for (const file of files) { hash.update(file); hash.update('\0'); try { hash.update(readFileSync(path.join(root, file))); } catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('<deleted>'); } hash.update('\0'); }
  return { sha256: hash.digest('hex'), files: files.length };
}
export function verifyPredictionPacket(directory, sourceRoot) {
  const machineFile = path.join(directory, 'machine.json'), raw = readFileSync(machineFile);
  const machine = JSON.parse(raw), review = JSON.parse(readFileSync(path.join(directory, 'review.json')));
  assert.equal(machine.passed, true); assert.ok(machine.cases.length >= 16);
  assert.equal(machine.sourceFingerprint.sha256, sourceFingerprint(sourceRoot).sha256, 'source changed after capture');
  assert.equal(review.machineSha256, sha256(raw), 'review belongs to another capture');
  assert.equal(review.independent, false, 'implementer self-review must be identified');
  assert.equal(review.accepted, true); assert.ok(review.limitations?.length > 0);
  assert.equal(review.screenshots.length, machine.screenshots.length);
  for (const screenshot of machine.screenshots) {
    assert.equal(screenshot.sha256, sha256(readFileSync(screenshot.file)), `changed screenshot: ${screenshot.name}`);
    const inspected = review.screenshots.find(row => row.name === screenshot.name);
    assert.equal(inspected?.passed, true); assert.ok(inspected.observations?.length > 20);
  }
  return { passed: true, cases: machine.cases.length, screenshots: machine.screenshots.length, sourceFingerprint: machine.sourceFingerprint, independent: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]; assert.ok(directory, 'Usage: input-prediction-evidence.mjs <packet-directory>');
  console.log(JSON.stringify(verifyPredictionPacket(path.resolve(directory), fileURLToPath(new URL('../../..', import.meta.url))), null, 2));
}
