import assert from 'node:assert/strict';
import test from 'node:test';
import { mostRestrictiveHookDecision } from './index.ts';

test('mostRestrictiveHookDecision keeps hook record merge semantics', () => {
  assert.equal(mostRestrictiveHookDecision([]), 'allow');
  assert.equal(mostRestrictiveHookDecision([{ decision: 'allow' }, { decision: 'ask' }]), 'ask');
  assert.equal(mostRestrictiveHookDecision([{ decision: 'ask' }, { decision: 'deny' }]), 'deny');
});

test('mostRestrictiveHookDecision ignores missing records and decisions', () => {
  assert.equal(mostRestrictiveHookDecision([null, undefined, {}]), 'allow');
  assert.equal(mostRestrictiveHookDecision([{ decision: null }, { decision: 'ask' }]), 'ask');
});
