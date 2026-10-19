import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRecoveryCheckpointView } from './recovery-checkpoint-view.mjs';
import { replyRecoveryAdmission } from './reply-recovery-admission.mjs';

test('compact checkpoint view preserves admission, observes corruption and cannot replace command contents', t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'peer-recovery-view-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ref = 'a'.repeat(64) + '.json', nativeRef = 'b'.repeat(64) + '.json';
  const checkpoint = { job: { workId: 'w' }, outcome: { rounds: [{ toolCalls: [{ result: { actual: 'large evidence' } }] }] } };
  writeFileSync(path.join(directory, ref), JSON.stringify(checkpoint));
  writeFileSync(path.join(directory, nativeRef), JSON.stringify({ actualNativeContext: 'large private context' }));
  const read = createRecoveryCheckpointView(directory), work = { workId: 'w', state: 'blocked_system', nativeCheckpointRef: nativeRef };
  const view = read(ref);
  assert.deepEqual(replyRecoveryAdmission(work, view, { readCheckpoint: read }),
    replyRecoveryAdmission(work, checkpoint, { readCheckpoint: () => ({ actualNativeContext: 'native' }) }));
  assert.ok(!JSON.stringify(view).includes('large evidence'));
  view.job.workId = 'forged'; assert.equal(read(ref).job.workId, 'w');
  writeFileSync(path.join(directory, nativeRef), '{broken');
  assert.equal(replyRecoveryAdmission(work, read(ref), { readCheckpoint: read }).code, 'RECOVERY_CHECKPOINT_UNAVAILABLE');
  writeFileSync(path.join(directory, ref), '{broken'); assert.throws(() => read(ref));
  assert.throws(() => read('../foreign'), /invalid_checkpoint/);
});

test('continuation discovery excludes execution payloads and invalidates changed, corrupt and deleted checkpoints', async t => {
  const { createContinuationCheckpointView } = await import('./recovery-checkpoint-view.mjs');
  const directory = mkdtempSync(path.join(tmpdir(), 'peer-continuation-view-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ref = 'c'.repeat(64)+'.json', file=path.join(directory,ref);
  const checkpoint={job:{workId:'w',kind:'wake',interactive:false,userInputs:[{inputId:'i',createdAt:'2026-10-19T00:00:00Z',text:'private body'}],events:[{eventId:'e',kind:'report_available',sessionId:'s',payload:'large result'}]},outcome:{rounds:[{text:'native history'}]}};
  writeFileSync(file,JSON.stringify(checkpoint));
  const read=createContinuationCheckpointView(directory),view=read(ref);
  assert.equal(view.outcome,undefined);assert.equal(view.job.events[0].payload,undefined);assert.equal(view.job.userInputs[0].text,undefined);
  view.job.workId='forged';assert.equal(read(ref).job.workId,'w');
  checkpoint.job.workId='changed';writeFileSync(file,JSON.stringify(checkpoint));assert.equal(read(ref).job.workId,'changed');
  writeFileSync(file,'{broken');assert.throws(()=>read(ref));
  rmSync(file);assert.throws(()=>read(ref));assert.throws(()=>read('../outside'),/invalid_checkpoint/);
});
