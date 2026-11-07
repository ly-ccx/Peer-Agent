import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { COORDINATION_WORKER_SOURCE } from './coordination-worker-source.generated.mjs';

const portableRequire = "path.join(process.cwd(), 'embedded-storage-worker.mjs')";

test('embedded coordination worker uses a cross-platform require base', () => {
  assert.ok(!COORDINATION_WORKER_SOURCE.includes("'file:///embedded-storage-worker.mjs'"));
  assert.ok(COORDINATION_WORKER_SOURCE.includes(portableRequire));
});

test('embedded coordination worker boots and rebuilds on the current platform', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-coordination-worker-'));
  try {
    const message = await new Promise((resolve, reject) => {
      const worker = new Worker(COORDINATION_WORKER_SOURCE, { eval: true, workerData: { coordinationRebuild: {
        dir: root,
        legacy: path.join(root, 'coordination.jsonl'),
        target: path.join(root, '.read-models', 'candidate.sqlite'),
        generation: 'worker-boot-test',
        requireHead: false,
        legacyIntegrity: null,
      } } });
      const timer = setTimeout(() => { void worker.terminate(); reject(new Error('coordination worker timeout')); }, 30000);
      worker.once('message', value => { clearTimeout(timer); void worker.terminate(); resolve(value); });
      worker.once('error', error => { clearTimeout(timer); void worker.terminate(); reject(error); });
    });
    assert.equal(message.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
