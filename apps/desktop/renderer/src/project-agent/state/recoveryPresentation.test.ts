import assert from 'node:assert/strict';
import test from 'node:test';
import { agentFailurePresentation, isRetiredRecovery } from './recoveryPresentation.ts';

test('only explicit host retirement folds interruption records', () => {
  const retired = { cardId: 'old', kind: 'agent_unavailable', content: 'old error', resolvedState: 'resolved' as const };
  assert.equal(isRetiredRecovery([retired]), true);
  assert.equal(isRetiredRecovery([]), false);
  assert.equal(isRetiredRecovery([{ ...retired, resolvedState: 'open' }]), false);
  assert.equal(isRetiredRecovery([{ ...retired, kind: 'approval' }]), false);
  assert.equal(isRetiredRecovery([{ ...retired, kind: 'agent_stopped' }]), false);
  assert.equal(isRetiredRecovery([retired, { ...retired, cardId: 'current', resolvedState: 'open' }]), false);
});

test('empty provider content and incompatible continuation have distinct user-facing reasons', () => {
  const card = { cardId: 'failure', kind: 'agent_unavailable', content: '代理暂时不可用：empty_model_response: no output' };
  assert.equal(agentFailurePresentation(card).messageKey, 'projectAgent.chat.recoveryEmptyResponse');
  assert.equal(agentFailurePresentation(card).retryAllowed, true);
  const changed = { ...card, content: '代理暂时不可用：continuity_model_changed' };
  assert.equal(agentFailurePresentation(changed).messageKey, 'projectAgent.chat.recoveryModelChanged');
  assert.equal(agentFailurePresentation(changed).retryAllowed, false);
  assert.equal(agentFailurePresentation({ ...changed, resolvedState: 'resolved' }).messageKey, 'projectAgent.chat.recoveryEarlierReply');
});

test('folded history distinguishes actual recovery from a superseded reply', () => {
  const base = { cardId: 'old', kind: 'agent_unavailable', content: 'old failure', resolvedState: 'resolved' as const };
  const status = { phase: 'recovered' as const, turnKind: 'user' as const, activeSessionIds: [] };
  assert.equal(isRetiredRecovery([{ ...base, failureStatus: { ...status, phase: 'current' } }]), false);
  assert.equal(agentFailurePresentation({ ...base, failureStatus: status }).messageKey, 'projectAgent.chat.recoveryEnded');
  assert.equal(agentFailurePresentation({ ...base, failureStatus: { ...status, phase: 'superseded' } }).messageKey, 'projectAgent.chat.recoveryEarlierReply');
});

test('a known host effort rejection names the configuration problem without exposing arbitrary diagnostics', () => {
  const card = { cardId: 'failure', kind: 'agent_unavailable', content: '代理暂时不可用：所选模型不支持该推理强度' };
  assert.equal(agentFailurePresentation(card).messageKey, 'projectAgent.chat.recoveryReasoning');
  assert.equal(agentFailurePresentation({ ...card, recoveryAction: { canContinue: false } }).retryAllowed, false);
  assert.equal(agentFailurePresentation({ ...card, resolvedState: 'resolved' }).messageKey, 'projectAgent.chat.recoveryEarlierReply');
  assert.equal(agentFailurePresentation({ ...card, content: 'PRIVATE_DIAGNOSTIC 所选模型不支持该推理强度' }).messageKey, 'projectAgent.chat.unavailable');
});
