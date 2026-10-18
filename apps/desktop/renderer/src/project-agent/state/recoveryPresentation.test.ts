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
  assert.equal(agentFailurePresentation({ ...changed, resolvedState: 'resolved' }).messageKey, 'projectAgent.chat.recoveryEnded');
});
