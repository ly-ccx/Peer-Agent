import test from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionReview } from './permission-review.mjs';

function createRuleStore(decision) {
  return {
    decide: () => ({ ...decision }),
    listRules: () => [],
    addRule: (rule) => rule,
  };
}

const safeClassification = {
  riskLevel: 'L1_readonly',
  category: 'readonly',
};

const destructiveClassification = {
  riskLevel: 'L5_destructive',
  category: 'destructive',
};

async function decide(ruleDecision, hookDecision, classification = safeClassification) {
  const review = createPermissionReview({
    shellRuleStore: createRuleStore({
      riskLevel: classification.riskLevel,
      category: classification.category,
      ...ruleDecision,
    }),
  });
  return review.decideShellExecution({
    call: { capabilityId: 'local.shell.exec' },
    classification,
    hookDecision,
  });
}

test('permission review uses runtime-core merge so hook deny tightens shell allow', async () => {
  const decision = await decide(
    { behavior: 'allow', granted: true, reason: 'matched_shell_allow_rule' },
    { behavior: 'deny' },
  );

  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.granted, false);
  assert.equal(decision.reason, 'hook_denied');
  assert.equal(decision.hookDecision.behavior, 'deny');
});

test('permission review keeps shell deny when hook allows', async () => {
  const decision = await decide(
    { behavior: 'deny', granted: false, reason: 'matched_shell_deny_rule' },
    { behavior: 'allow' },
  );

  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.granted, false);
  assert.equal(decision.reason, 'matched_shell_deny_rule');
  assert.equal(decision.hookDecision.behavior, 'allow');
});

test('permission review keeps L5_destructive denied when hook allows', async () => {
  const decision = await decide(
    { behavior: 'deny', granted: false, reason: 'destructive_shell_command_denied' },
    { behavior: 'allow' },
    destructiveClassification,
  );

  assert.equal(decision.behavior, 'deny');
  assert.equal(decision.granted, false);
  assert.equal(decision.reason, 'destructive_shell_command_denied');
  assert.equal(decision.riskLevel, 'L5_destructive');
});

test('permission review uses hook ask to tighten shell allow', async () => {
  const decision = await decide(
    { behavior: 'allow', granted: true, reason: 'matched_shell_allow_rule' },
    { behavior: 'ask' },
  );

  assert.equal(decision.behavior, 'ask');
  assert.equal(decision.granted, false);
  assert.equal(decision.reason, 'hook_approval_required');
});

test('permission review keeps shell ask when hook allows', async () => {
  const decision = await decide(
    { behavior: 'ask', granted: false, reason: 'matched_shell_ask_rule' },
    { behavior: 'allow' },
  );

  assert.equal(decision.behavior, 'ask');
  assert.equal(decision.granted, false);
  assert.equal(decision.reason, 'matched_shell_ask_rule');
});
