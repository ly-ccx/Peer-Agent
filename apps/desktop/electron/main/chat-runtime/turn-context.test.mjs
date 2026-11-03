import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTurnProfile, projectTurnSystemContext } from './turn-context.mjs';

test('host turn normalization retains the current child lease and model choices', () => {
  const coordinationBinding = { workId: 'work', sessionId: 'child', goalRevision: 2, executionEpoch: 'epoch-2' };
  const input = { role: 'work_session', agentKind: 'worker', workspaceId: 'workspace', workId: 'work', sessionId: 'child', coordinationBinding,
    modelSelection: { modelProviderId: 'model', reasoningEffort: 'high', fastMode: true } };
  const profile = normalizeTurnProfile(input);
  assert.deepEqual(profile.coordinationBinding, coordinationBinding);
  assert.equal(profile.modelSelection.reasoningEffort, 'high');
  assert.equal(profile.modelSelection.fastMode, true);
  for (const patch of [{ workId: 'other' }, { sessionId: 'other' }, { goalRevision: -1 }, { executionEpoch: '' }]) {
    assert.equal(normalizeTurnProfile({ ...input, coordinationBinding: { ...coordinationBinding, ...patch } }).coordinationBinding, undefined);
  }
});
test('canonical execution identity and the private review token survive host normalization without joining factual context', () => {
  const identity = { planId: 'plan', sessionId: 'child', executionEpoch: 'epoch', generation: 'generation', goalRevision: 3 };
  const input = { role: 'work_session', agentKind: 'verifier', planId: 'plan', sessionId: 'child', executionIdentity: identity,
    interactiveReview: { token: 'host-issued-token' } };
  const profile = normalizeTurnProfile(input);
  assert.deepEqual(profile.executionIdentity, identity); assert.deepEqual(profile.interactiveReview, { token: 'host-issued-token' });
  assert.equal(profile.context, undefined);
  const context = JSON.stringify(projectTurnSystemContext(profile, { memoryEnabled: false }));
  assert.equal(context.includes('host-issued-token'), false);
  assert.equal(context.includes('interactiveReview'), false);
  identity.executionEpoch = 'mutated'; assert.equal(profile.executionIdentity.executionEpoch, 'epoch');
  for (const patch of [{ planId: 'foreign' }, { sessionId: 'foreign' }, { executionEpoch: '' }, { granted: true }]) {
    assert.equal(normalizeTurnProfile({ ...input, executionIdentity: { ...identity, ...patch } }).executionIdentity, undefined);
  }
  assert.equal(normalizeTurnProfile({ ...input, interactiveReview: { token: 'token', granted: true } }).interactiveReview, undefined);
});
