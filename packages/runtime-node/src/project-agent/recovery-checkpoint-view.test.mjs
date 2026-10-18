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
