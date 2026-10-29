import test from 'node:test';import assert from 'node:assert/strict';
import { createAttentionExpiry } from './attention-expiry.mjs';
test('one timer per workspace refreshes at the deadline and cannot revive superseded callbacks', () => {
  let at = 0; const timers = [], cancelled = [], expired = [];
  const expiry = createAttentionExpiry({ now: () => new Date(at).toISOString(),
    schedule: (fn, ms) => { const id = timers.length; timers.push({ fn, ms }); return id; }, cancel: id => cancelled.push(id), onExpired: id => expired.push(id) });
  expiry.observe('w', new Date(100).toISOString()); expiry.observe('w', new Date(100).toISOString()); assert.equal(timers.length, 1);
  expiry.observe('w', new Date(200).toISOString()); assert.deepEqual(cancelled, [0]);
  at = 100; timers[0].fn(); assert.deepEqual(expired, []);
  at = 200; timers[1].fn(); assert.deepEqual(expired, ['w']);
  expiry.observe('other', new Date(300).toISOString()); expiry.retain(['w']);
  at = 300; timers[2].fn(); assert.deepEqual(expired, ['w']);
});
test('a backwards clock rechecks rather than expiring a live decision', () => {
  let at = 0; const timers = [], expired = [];
  const expiry = createAttentionExpiry({ now: () => new Date(at).toISOString(), schedule: fn => { timers.push(fn); }, onExpired: id => expired.push(id) });
  expiry.observe('w', new Date(100).toISOString()); timers[0](); assert.equal(timers.length, 2); assert.equal(expired.length, 0);
  at = 100; timers[1](); assert.deepEqual(expired, ['w']); expiry.dispose();
});

test('an elapsed deadline still publishes once when a read removes or replaces it before its timer runs', () => {
  let at = 0; const timers = [], expired = [];
  const expiry = createAttentionExpiry({ now: () => new Date(at).toISOString(),
    schedule: fn => { timers.push(fn); }, onExpired: id => expired.push(id) });
  expiry.observe('removed', new Date(100).toISOString());
  expiry.observe('replaced', new Date(100).toISOString());
  at = 100;
  expiry.observe('removed', undefined);
  expiry.observe('removed', undefined);
  expiry.observe('replaced', new Date(200).toISOString());
  timers[0](); timers[1]();
  assert.deepEqual(expired, ['removed', 'replaced']);
  at = 200; timers[2]();
  assert.deepEqual(expired, ['removed', 'replaced', 'replaced']);
});

test('removing a workspace or disposing never broadcasts, even with overdue timers', () => {
  let at = 0; const timers = [], expired = [];
  const expiry = createAttentionExpiry({ now: () => new Date(at).toISOString(),
    schedule: fn => { timers.push(fn); }, onExpired: id => expired.push(id) });
  expiry.observe('removed', new Date(100).toISOString());
  expiry.observe('disposed', new Date(100).toISOString());
  at = 100; expiry.retain(['disposed']); expiry.dispose();
  for (const fn of timers) fn();
  assert.deepEqual(expired, []);
});
