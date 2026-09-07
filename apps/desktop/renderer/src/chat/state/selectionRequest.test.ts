import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionRequestGate } from './selectionRequest.ts';

for (const invalidation of ['switch-session', 'new-selection', 'unmount']) {
  for (const result of ['success', 'failure']) {
    test(`quote request ${invalidation} × ${result}: stale result cannot mutate newer draft or busy state`, async () => {
      const gate = createSelectionRequestGate();
      const old = gate.begin()!;
      assert.equal(gate.begin(), null, 'double activation is suppressed');
      gate.invalidate();
      const current = gate.begin()!;
      const updates: string[] = [];
      await Promise.resolve();
      if (old.isCurrent()) updates.push(result);
      assert.equal(old.finish(), false);
      assert.equal(current.isCurrent(), true);
      assert.equal(gate.begin(), null, 'old finally must not release current request');
      assert.deepEqual(updates, []);
      assert.equal(current.finish(), true);
      assert.equal(current.finish(), false);
      assert.equal(current.isCurrent(), false);
      assert.ok(gate.begin());
    });
  }
}
for (const result of ['success', 'failure']) test(`quote request unchanged × ${result}: settles and permits retry`, () => {
  const gate = createSelectionRequestGate();
  const request = gate.begin()!;
  assert.equal(request.isCurrent(), true);
  assert.equal(request.finish(), true);
  assert.ok(gate.begin());
});
