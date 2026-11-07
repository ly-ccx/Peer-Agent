import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { setDiagnosticPhaseObserver } from '../diagnostic-phase.mjs';

test('idle continuation checks do not rescan a stable coordination journal', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'continuation-scale-'));
  const store = createWorkCoordinationStore({
    rootDir: root, workspaceId: 'ws-1', holdsLease: () => true, leaseEpoch: () => 'owner',
    formatVersion: 2, fenceLegacyWrites: true,
  });
  await store.prepare();
  try {
    const count = 800;
    for (let i = 0; i < count; i += 1) {
      store.saveWork({
        workId: `work-${i}`, workspaceId: 'ws-1', parentConversationId: 'conv',
        state: 'delivered', sessionIds: [], checkpointRef: undefined,
      }, { returnState: false });
    }
    const revision = store.revision();
    let snapshots = 0;
    const readSnapshot = store.readSnapshot.bind(store);
    store.readSnapshot = () => { snapshots += 1; return readSnapshot(); };
    const phases = [];
    const previous = setDiagnosticPhaseObserver((name, fields) => phases.push({ name, ...fields }));
    const coordination = createRunnerCoordination({
      store, workspaceId: 'ws-1', conversationId: 'conv',
    });
    try {
      const firstStarted = performance.now();
      assert.equal(coordination.hasContinuation(), false);
      const firstMs = performance.now() - firstStarted;
      const firstSnapshots = snapshots;
      assert.equal(store.revision(), revision);
      phases.length = 0;
      const secondStarted = performance.now();
      assert.equal(coordination.hasContinuation(), false);
      const secondMs = performance.now() - secondStarted;
      assert.equal(snapshots, firstSnapshots);
      assert.equal(store.revision(), revision);
      assert.equal(phases.filter(phase => phase.name === 'watch.continuation' && phase.hit === 1).length, 1);
      assert.ok(secondMs * 5 < firstMs, `second ${Math.round(secondMs)}ms vs first ${Math.round(firstMs)}ms`);
      assert.ok(secondMs < 40, `cached continuation took ${Math.round(secondMs)}ms`);
    } finally {
      setDiagnosticPhaseObserver(previous);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
