import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkBudgetPolicy, effectiveWorkLimits, budgetBoundary, legacyBudgetMigration } from './work-budget-policy.mjs';
const legacy = { maxModelRequests: 256, maxToolCalls: 2048, source: 'system:execution-continuity-v1' };
const work = () => ({ state: 'budget_limited', budget: { modelRequests: 256, toolCalls: 468, tokens: 99,
  costUsd: 0, unknownUsage: true, unknownCost: true, attempts: {}, limits: legacy } });

test('default policy accounts without a lifetime call cap; explicit zero and unknown usage still stop', () => {
  const policy = resolveWorkBudgetPolicy();
  assert.equal(policy.maxModelRequests, undefined); assert.equal(policy.maxToolCalls, undefined);
  assert.equal(budgetBoundary({ modelRequests: 300, toolCalls: 2050, unknownCost: true }, policy), null);
  assert.equal(budgetBoundary({}, resolveWorkBudgetPolicy({ maxModelRequests: 0 })).metric, 'modelRequests');
  assert.equal(budgetBoundary({ tokens: 3, unknownUsage: true }, resolveWorkBudgetPolicy({ maxTokens: 10 })).reason, 'usage_unknown');
  assert.throws(() => resolveWorkBudgetPolicy({ maxCostUsd: -1 }), /policy_invalid/);
});

test('only exact obsolete defaults migrate; explicit and unknown policies stay enforced', () => {
  const original = work(), policy = resolveWorkBudgetPolicy();
  const migrated = legacyBudgetMigration(original, policy, '2026-10-18T00:00:00Z');
  assert.equal(migrated.limits.schemaVersion, 2); assert.equal(migrated.modelRequests, 256);
  assert.deepEqual(migrated.policyMigration.previousLimits, legacy);
  assert.equal(original.budget.limits.maxModelRequests, 256, 'input truth is not mutated');
  for (const limits of [{ ...legacy, maxModelRequests: 200 }, { ...legacy, maxTokens: 99 },
    { ...legacy, source: 'settings:execution-budget' }, { ...legacy, source: undefined }]) {
    const row = { ...original, budget: { ...original.budget, limits } };
    assert.equal(legacyBudgetMigration(row, policy), null);
    assert.equal(effectiveWorkLimits(row.budget, policy).maxModelRequests, limits.maxModelRequests);
  }
  assert.equal(legacyBudgetMigration(original, resolveWorkBudgetPolicy({ maxModelRequests: 256 })), null);
});
