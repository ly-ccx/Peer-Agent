import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrace, distribution, inspectorValue, synchronizeClocks, requestPhases } from './trace.mjs';

test('nested synchronous spans account once and retain an explicit await/unsegmented remainder', async () => {
  let clock = 0;
  const trace = createTrace({ now: () => clock });
  await trace.request('request', () => {
    clock = 1;
    trace.sync('outer', () => {
      clock = 3;
      trace.sync('inner', () => { clock = 8; });
      clock = 10;
    });
    clock = 20;
  });
  const [receipt] = trace.take();
  assert.equal(receipt.metrics['request > outer'].inclusiveMs, 9);
  assert.equal(receipt.metrics['request > outer'].selfMs, 4);
  assert.equal(receipt.metrics['request > outer > inner'].selfMs, 5);
  assert.equal(receipt.durationMs, 20);
  assert.equal(receipt.unsegmentedOrAwaitMs, 11);
  assert.equal(trace.take().length, 0);
});

test('interleaved asynchronous requests do not share counters or argument content', async () => {
  const trace = createTrace();
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const first = trace.request('first', async () => { trace.count('count', 2); await barrier; trace.count('count', 3); });
  await trace.request('second', () => { trace.count('count', 7); release(); });
  await first;
  const receipts = trace.take();
  assert.equal(receipts.find(row => row.name === 'first').counts.count, 5);
  assert.equal(receipts.find(row => row.name === 'second').counts.count, 7);
  assert.equal(new Set(receipts.map(row => row.requestId)).size, 2);
});

test('wrapped methods preserve identity, return, exception and restore without exposing payload', async () => {
  const trace = createTrace();
  const failure = new Error('fixture failure');
  const object = { call(value) { assert.equal(this, object); if (value) throw failure; return 42; } };
  const original = object.call;
  const restore = trace.wrap(object, 'call', 'owner.call');
  await trace.request('normal', () => assert.equal(object.call(false), 42));
  await assert.rejects(trace.request('failure', () => object.call('private-value')), error => error === failure);
  assert.equal(JSON.stringify(trace.take()).includes('private-value'), false);
  restore(); assert.equal(object.call, original);
});

test('inspector evaluation exceptions cannot be mistaken for a successful cleanup acknowledgement', () => {
  assert.throws(() => inspectorValue({ result: { subtype: 'error' } }), /evaluation_failed/);
  assert.throws(() => inspectorValue({ exceptionDetails: { text: 'error' } }), /evaluation_failed/);
  assert.equal(inspectorValue({ result: { type: 'boolean', value: true } }), true);
});

test('distribution preserves every sample and rejects invalid measurements', () => {
  assert.deepEqual(distribution([600, 1, 2, 3]), { n: 4, p50: 3, p95: 600, max: 600 });
  assert.equal(distribution([]).max, null);
  assert.throws(() => distribution([NaN]), /invalid measurement/);
  assert.throws(() => distribution([-1]), /invalid measurement/);
});

test('cross-process phase accounting retains clock uncertainty and the full round trip', () => {
  const clock = synchronizeClocks([{ start: 0, end: 2, enteredMain: 101, settledMain: 101 }]);
  assert.equal(clock.offsetMs, 100); assert.equal(clock.uncertaintyMs, 1);
  const row = requestPhases({ start: 0, end: 32, enteredMain: 105, settledMain: 125 }, clock);
  assert.equal(row.sendQueueMs, 5); assert.equal(row.handlerMs, 20); assert.equal(row.replyMs, 7);
  assert.equal(row.sendQueueMs + row.handlerMs + row.replyMs, row.roundTripMs);
  assert.throws(() => synchronizeClocks([{ start: 0, end: 1, enteredMain: 0, settledMain: 3 }]), /inconsistent/);
});

test('quantized renderer timestamps do not imply negative transport time or relaxed main-loop budgets', () => {
  const quantized = [{ start: 0, end: 0, enteredMain: 100, settledMain: 100.02 }];
  assert.throws(() => synchronizeClocks(quantized), /inconsistent/);
  const calibration = synchronizeClocks(quantized, { timestampUncertaintyMs: 1 });
  assert.equal(calibration.timestampUncertaintyMs, 1);
  assert.ok(calibration.uncertaintyMs > 0);
  assert.throws(() => synchronizeClocks([{ start: 0, end: 0, enteredMain: 100, settledMain: 103 }],
    { timestampUncertaintyMs: 1 }), /inconsistent/);
});
