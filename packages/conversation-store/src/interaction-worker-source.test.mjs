import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERACTION_WORKER_SOURCE } from './interaction-worker-source.generated.mjs';

test('embedded interaction worker uses a cross-platform require base', () => {
  assert.ok(!INTERACTION_WORKER_SOURCE.includes("'file:///embedded-storage-worker.mjs'"));
  assert.ok(INTERACTION_WORKER_SOURCE.includes("path.join(process.cwd(), 'embedded-storage-worker.mjs')"));
});
