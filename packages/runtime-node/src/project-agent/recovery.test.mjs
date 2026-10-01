import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectRecovery, RECOVERY_PHASES } from './recovery.mjs';

test('recovery is ordered, joins concurrent calls and isolates one project failure', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-recovery-')); const seen = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  try {
    const ports = Object.fromEntries(RECOVERY_PHASES.map(phase => [phase, async workspaceId => {
      seen.push(`${workspaceId}:${phase}`);
      if (workspaceId === 'good' && phase === 'lease') await gate;
      if (workspaceId === 'bad' && phase === 'inbox') throw new Error('corrupt inbox');
    }]));
    const recovery = createProjectRecovery({ rootDir, ports, holdsLease: () => true });
    const first = recovery.recover('good'); const duplicate = recovery.recover('good');
    const bad = await recovery.recover('bad');
    assert.equal(bad.ok, false); assert.equal(bad.phase, 'inbox'); assert.equal(recovery.isReady('bad'), false);
    release(); await Promise.all([first, duplicate]);
    assert.equal(recovery.isReady('good'), true);
    assert.deepEqual(seen.filter(item => item.startsWith('good:')), RECOVERY_PHASES.map(phase => `good:${phase}`));
    assert.equal((await recovery.recover('good')).reused, true);
    const diagnostic = JSON.parse(readFileSync(path.join(rootDir, 'bad', 'recovery.json')));
    assert.equal(diagnostic.phase, 'inbox'); assert.equal(diagnostic.error, 'corrupt inbox');
    recovery.drop('good'); assert.equal(recovery.isReady('good'), false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('losing a lease between recovery stages never opens execution admission', async () => {
  let owned = true; const seen = [];
  const ports = Object.fromEntries(RECOVERY_PHASES.map(phase => [phase, () => { seen.push(phase); if (phase === 'inputs') owned = false; }]));
  const recovery = createProjectRecovery({ persistDiagnostic: () => {}, ports, holdsLease: () => owned });
  assert.equal((await recovery.recover('ws')).ok, false);
  assert.equal(recovery.isReady('ws'), false); assert.deepEqual(seen, ['lease', 'inputs']);
});
