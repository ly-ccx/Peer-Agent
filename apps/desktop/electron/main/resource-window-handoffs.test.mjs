import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createResourceWindowHandoffs } from './resource-window-handoffs.mjs';
const identity = { viewId: 'view', windowId: 'window', generation: 1 };
function fixture() {
  const timers = new Map(); let id = 0;
  const host = createResourceWindowHandoffs({ createId: () => `request-${++id}`, schedule: (fn, ms) => { const handle = Symbol(); timers.set(handle, { fn, ms }); return handle; }, cancel: handle => timers.delete(handle) });
  return { host, timers };
}
test('only the captured sender and exact generation may confirm a return; old acknowledgements cannot focus another view', async () => {
  const { host, timers } = fixture(), source = new EventEmitter(); let requestId;
  const result = host.request(source, identity, 'return', id => { requestId = id; });
  assert.equal([...timers.values()][0].ms, 3000);
  assert.equal(host.acknowledge(new EventEmitter(), { requestId, identity, status: 'returned' }, 'return'), false);
  assert.equal(host.acknowledge(source, { requestId, identity: { ...identity, generation: 2 }, status: 'returned' }, 'return'), false);
  assert.equal(host.acknowledge(source, { requestId, identity, status: 'confirmed' }, 'return'), false);
  assert.equal(host.acknowledge(source, { requestId, identity, status: 'source_tab_closed' }, 'return'), true);
  assert.equal(await result, 'source_tab_closed'); assert.equal(timers.size, 0); assert.equal(source.listenerCount('destroyed'), 0);
  assert.equal(host.acknowledge(source, { requestId, identity, status: 'returned' }, 'return'), false);
});
test('close timeout is unconfirmed, and release/dispose/source loss retires pending handoffs', async () => {
  const { host, timers } = fixture(), source = new EventEmitter();
  let requestId;
  const close = host.request(source, identity, 'checkpoint', id => { requestId = id; }); const timer = [...timers.values()][0]; assert.equal(timer.ms, 500); timer.fn(); assert.equal(await close, 'unconfirmed');
  assert.equal(host.acknowledge(source, { requestId, identity, status: 'confirmed' }, 'checkpoint'), false, 'late confirmation cannot authorize closing');
  const returning = host.request(source, identity, 'return', () => {}); source.emit('destroyed'); assert.equal(await returning, 'source_unavailable');
  const released = host.request(source, identity, 'return', () => {}); host.release(identity); assert.equal(await released, 'cancelled');
  const disposed = host.request(source, identity, 'return', () => {}); host.dispose(); assert.equal(await disposed, 'cancelled'); assert.equal(timers.size, 0);
});

test('checkpoint requires an explicit result and permits a fresh retry after blocked saving', async () => {
  const { host, timers } = fixture(), source = new EventEmitter(); let requestId;
  const first = host.request(source, identity, 'checkpoint', id => { requestId = id; });
  assert.equal(host.acknowledge(source, { requestId, identity }, 'checkpoint'), false);
  assert.equal(host.acknowledge(new EventEmitter(), { requestId, identity, status: 'confirmed' }, 'checkpoint'), false);
  assert.equal(host.acknowledge(source, { requestId, identity, status: 'blocked' }, 'checkpoint'), true);
  assert.equal(await first, 'blocked');
  const oldId = requestId;
  const retry = host.request(source, identity, 'checkpoint', id => { requestId = id; });
  assert.equal(host.acknowledge(source, { requestId: oldId, identity, status: 'confirmed' }, 'checkpoint'), false);
  assert.equal(host.acknowledge(source, { requestId, identity, status: 'confirmed' }, 'checkpoint'), true);
  assert.equal(await retry, 'confirmed'); assert.equal(timers.size, 0); host.dispose();
});

test('a newer return from the same view replaces the older request and keeps pending work bounded', async () => {
  const { host, timers } = fixture(), source = new EventEmitter(); let latest;
  const old = host.request(source, identity, 'return', () => {});
  const current = host.request(source, identity, 'return', requestId => { latest = requestId; });
  assert.equal(await old, 'cancelled'); assert.equal(timers.size, 1);
  assert.equal(host.acknowledge(source, { requestId: latest, identity, status: 'returned' }, 'return'), true);
  assert.equal(await current, 'returned'); assert.equal(timers.size, 0); host.dispose();
});
