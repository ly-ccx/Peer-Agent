import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { setDiagnosticPhaseObserver } from '../diagnostic-phase.mjs';

test('reconcile rereads of an unchanged ledger do not rebuild the snapshot', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ledger-cache-'));
  const store = createWorkCoordinationStore({
    rootDir: root, workspaceId: 'ws-1', holdsLease: () => true, leaseEpoch: () => 'owner',
    formatVersion: 2, fenceLegacyWrites: true,
  });
  await store.prepare();
  const history = 'x'.repeat(2048);
  try {
    for (let i = 0; i < 400; i += 1) {
      store.saveWork({
        workId: `work-${i}`, workspaceId: 'ws-1', parentConversationId: 'conv',
        state: 'delivered', sessionIds: [], budget: { history },
      }, { returnState: false });
    }
    const revision = store.revision();
    const phases = [];
    const previous = setDiagnosticPhaseObserver((name, fields) => phases.push({ name, ...fields }));
    try {
      const firstStarted = performance.now();
      const first = store.read();
      const firstMs = performance.now() - firstStarted;
      assert.equal(first.works['work-0'].state, 'delivered');
      const secondStarted = performance.now();
      const second = store.read();
      const secondMs = performance.now() - secondStarted;
      assert.equal(second.works['work-399'].state, 'delivered');
      assert.equal(store.revision(), revision);
      assert.equal(phases.filter(phase => phase.name === 'watch.ledger' && phase.hit === 0).length, 1);
      assert.equal(phases.filter(phase => phase.name === 'watch.ledger' && phase.hit === 1).length, 1);
      assert.ok(secondMs * 5 < firstMs, `second ${Math.round(secondMs)}ms vs first ${Math.round(firstMs)}ms`);
      assert.ok(secondMs < 20, `cached ledger read took ${Math.round(secondMs)}ms`);
      store.saveWork({ workId: 'work-0', workspaceId: 'ws-1', parentConversationId: 'conv', state: 'cancelled', sessionIds: [] }, { returnState: false });
      assert.notEqual(store.revision(), revision);
      assert.equal(store.read().works['work-0'].state, 'cancelled');
    } finally {
      setDiagnosticPhaseObserver(previous);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
