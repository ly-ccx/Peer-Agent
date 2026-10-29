import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTurnProfile } from './turn-context.mjs';

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
