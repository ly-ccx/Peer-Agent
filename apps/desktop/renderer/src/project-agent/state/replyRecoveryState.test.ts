import test from 'node:test';
import assert from 'node:assert/strict';
import { readReplyRecoveryAction, budgetFailureDetail } from './replyRecoveryState.ts';
import { agentFailurePresentation } from './botConversationState.ts';

test('explicit limit facts explain usage and never offer an inadmissible retry', () => {
  const action = readReplyRecoveryAction({ canContinue: false, blockedReason: 'WORK_BUDGET_EXHAUSTED',
    budget: { metric: 'modelRequests', used: 256, limit: 256, source: 'settings:execution-budget', reason: 'limit_reached' } })!;
  const card = { cardId: 'error', kind: 'agent_unavailable', content: 'work_budget_limited', recoveryAction: action };
  assert.equal(agentFailurePresentation(card).retryAllowed, false);
  assert.equal(agentFailurePresentation(card).messageKey, 'projectAgent.chat.budgetExhausted');
  assert.equal(budgetFailureDetail(action)?.key, 'projectAgent.chat.budgetRequests');
  assert.equal(budgetFailureDetail(action)?.sourceKey, 'projectAgent.chat.budgetSourceSettings');
  assert.equal(agentFailurePresentation({ ...card, recoveryAction: { canContinue: true } }).messageKey, 'projectAgent.chat.budgetReady');
  assert.equal(agentFailurePresentation({ ...card, recoveryAction: { canContinue: true } }).retryAllowed, true);
  assert.equal(agentFailurePresentation({ ...card, recoveryAction: undefined }).retryAllowed, false);
});

test('unknown usage is not zero and malformed host diagnostics do not become public budget facts', () => {
  const unknown = { canContinue: false, budget: { metric: 'costUsd', used: null, limit: 10,
    source: 'settings:execution-budget', reason: 'usage_unknown' } };
  assert.equal(budgetFailureDetail(readReplyRecoveryAction(unknown))?.key, 'projectAgent.chat.budgetCostUnknown');
  assert.equal(readReplyRecoveryAction({ ...unknown, canContinue: 'yes' }), undefined);
  assert.equal(readReplyRecoveryAction({ ...unknown, budget: { ...unknown.budget, limit: Infinity } })?.budget, undefined);
});
