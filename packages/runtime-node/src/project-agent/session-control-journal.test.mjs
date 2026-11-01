import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { controlDigest } from './session-control-kernel.mjs';

test('control receipts survive a new reader and retain the version-seven writer fence', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-control-journal-'));
  const options = { rootDir: root, workspaceId: 'workspace', holdsLease: () => true, leaseEpoch: () => 'host', formatVersion: 2, fenceLegacyWrites: true };
  let store = createWorkCoordinationStore(options);
  try {
    await store.prepare();
    assert.equal(store.readSessionControl(undefined), undefined);
    assert.equal(store.readSessionControl(''), undefined);
    const operation = { operationId: 'cancel', kind: 'cancel', authorityRef: 'actual-input', revision: 1,
      workspaceId: 'workspace', parentConversationId: 'parent', sessionId: 'session', planId: 'plan',
      expectedExecution: { planId: 'plan', sessionId: 'session', executionEpoch: 'epoch' }, phase: 'recorded', updatedAt: '2026-11-01T00:00:00.000Z' };
    operation.requestDigest = controlDigest({ kind: operation.kind, operationId: operation.operationId, authorityRef: operation.authorityRef, execution: operation.expectedExecution });
    store.writeSessionControl(operation, 0, null);
    store.writeSessionControl({ ...operation, revision: 2, phase: 'draining' }, 1, operation.operationId);
    const receipt = { receiptId: 'receipt', operationId: 'cancel', execution: operation.expectedExecution,
      admissionClosed: true, runnerIdle: true, schedulerIdle: true, resourceClaims: [], unknownCalls: ['unresolved-call'], scope: 'managed_execution', completedAt: operation.updatedAt };
    store.writeSessionControl({ ...operation, revision: 3, phase: 'settled', outcome: 'applied', stopReceipt: receipt }, 2, operation.operationId);
    store.close(); store = createWorkCoordinationStore(options); await store.prepare();
    assert.deepEqual(store.readSessionControl('session').stopReceipt.unknownCalls, ['unresolved-call']);
    assert.equal(store.readSessionControl('session').outcome, 'applied');
    const manifest = JSON.parse(readFileSync(path.join(root, 'workspace/coordination-v2/manifest.json'), 'utf8'));
    assert.equal(manifest.minimumReaderVersion, 7);
    assert.equal(manifest.minimumWriterVersion, 7);
    assert.deepEqual(Object.keys(store.read().mandates || {}), [], 'legacy cancellation does not fabricate a coordination mandate');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
