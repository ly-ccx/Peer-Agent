import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import test from 'node:test';
import { writeStreamingCommand } from './rc-response-interaction-smoke.mjs';

test('an independent reader never sees a partial streaming command during phase changes', async () => {
  const root = mkdtempSync(tmpdir() + '/peer-stream-command-');
  const file = root + '/command.json';
  writeStreamingCommand(file, 'RC_STREAM_TEXT', 0);
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { readFileSync } = require('node:fs');
    const stop = new Int32Array(workerData.stop);
    let reads = 0;
    parentPort.postMessage('ready');
    try {
      while (!Atomics.load(stop, 0)) {
        const command = JSON.parse(readFileSync(workerData.file, 'utf8'));
        if (command.scenario !== 'RC_STREAM_TEXT' || !Number.isInteger(command.phase)) throw Error('invalid phase');
        reads++;
      }
      parentPort.postMessage({ reads });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
  `, { eval: true, workerData: { file, stop: stop.buffer } });
  try {
    await once(worker, 'message');
    const result = once(worker, 'message');
    for (let phase = 1; phase <= 3000; phase++) writeStreamingCommand(file, 'RC_STREAM_TEXT', phase);
    Atomics.store(stop, 0, 1);
    const [receipt] = await result;
    assert.equal(receipt.error, undefined);
    assert.ok(receipt.reads > 0);
  } finally { await worker.terminate(); rmSync(root, { recursive: true, force: true }); }
});
