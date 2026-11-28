import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createProviderRefreshOrder } from './providerRefreshOrder.ts';

test('pipelined concurrent provider refreshes still apply monotonically instead of livelocking', () => {
  const order = createProviderRefreshOrder();
  const t1 = order.begin();
  const t2 = order.begin();
  // t1 completes while t2 is still in flight — must still apply so the list updates immediately.
  assert.equal(order.canApply(t1), true);
  assert.equal(order.isLatest(t1), false);

  const t3 = order.begin();
  // t2 completes while t3 is in flight — also newer than t1, so it applies too.
  assert.equal(order.canApply(t2), true);
  assert.equal(order.isLatest(t2), false);

  assert.equal(order.canApply(t3), true);
  assert.equal(order.isLatest(t3), true);
});

test('out-of-order stale provider replies are still rejected after a newer reply commits', () => {
  const order = createProviderRefreshOrder();
  const t1 = order.begin();
  const t2 = order.begin();

  assert.equal(order.canApply(t2), true);
  assert.equal(order.canApply(t1), false);
});

test('unmount invalidates all in-flight provider refreshes and remount starts fresh', () => {
  const order = createProviderRefreshOrder();
  const t1 = order.begin();
  order.unmount();

  assert.equal(order.isAlive(), false);
  assert.equal(order.canApply(t1), false);
  assert.equal(order.isLatest(t1), false);

  order.mount();
  const t2 = order.begin();
  assert.equal(order.canApply(t1), false);
  assert.equal(order.canApply(t2), true);
  assert.equal(order.isLatest(t2), true);
});

test('deferPanel keeps its Suspense branch stable across lazy resolution during a mount', async () => {
  const source = await readFile(new URL('../components/deferPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /useState\(\(\) => resolved !== null\)/);
  assert.match(source, /const Direct = \(directAtMount \? resolved : null\)/);
});

test('LlmSettingsPanel keys catalog dialog target by groupId so removing the head model keeps dialog close intact', async () => {
  const source = await readFile(new URL('../components/LlmSettingsPanel.tsx', import.meta.url), 'utf8');
  assert.match(source, /openCatalog\(head\.id, g\.groupId\)/);
  assert.match(source, /\(provider\.groupId \?\? provider\.id\) === targetKey \|\| provider\.id === targetKey/);
});
