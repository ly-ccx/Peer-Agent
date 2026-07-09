import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRuntimeDecision, isDecisionAtLeast, mostRestrictiveDecision } from './index.ts';

test('mostRestrictiveDecision keeps allow as the default', () => {
  assert.equal(mostRestrictiveDecision([]), 'allow');
  assert.equal(mostRestrictiveDecision([undefined, null, 'allow']), 'allow');
});

test('mostRestrictiveDecision ranks deny over ask over allow', () => {
  assert.equal(mostRestrictiveDecision(['allow', 'ask']), 'ask');
  assert.equal(mostRestrictiveDecision(['ask', 'deny', 'allow']), 'deny');
  assert.equal(mostRestrictiveDecision(['deny', 'ask']), 'deny');
});

test('decision helpers compare by restrictiveness', () => {
  assert.equal(compareRuntimeDecision('allow', 'ask') < 0, true);
  assert.equal(compareRuntimeDecision('deny', 'ask') > 0, true);
  assert.equal(isDecisionAtLeast('deny', 'ask'), true);
  assert.equal(isDecisionAtLeast('allow', 'ask'), false);
});
