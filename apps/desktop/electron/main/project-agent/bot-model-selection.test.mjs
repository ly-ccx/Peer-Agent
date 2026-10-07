import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotModelSelectionUpdater } from './bot-model-selection.mjs';

function fixture() {
  const current = { workspaceId: 'bot', status: 'active', acceptancePolicy: 'auto', autonomyPolicy: 'full_local',
    modelPolicy: { scope: { modelProviderIds: ['m'] }, overrides: { verifier: { mode: 'tier', tier: 'strong' } } } };
  const result = { ok: true, item: { profile: current }, modelOptions: [{ id: 'm', available: true,
    defaultReasoningEffort: 'low', reasoningEffortLevels: ['low', 'high'] }, { id: 'outside', available: true }],
    modelViews: { project_agent: { eligibleModelIds: ['m'] } } };
  const writes = [];
  const update = createBotModelSelectionUpdater({ get: () => result, updateProfile: payload => { writes.push(payload); return { ok: true, profile: { ...current, modelPolicy: payload.modelPolicy } }; } });
  return { current, result, writes, update };
}
test('model choice pins only the Bot reply role and keeps its scope and other policies', async () => {
  const f = fixture(), before = structuredClone(f.current);
  const result = await f.update({ workspaceId: 'bot', modelProviderId: 'm', reasoningEffort: 'high' });
  assert.equal(result.ok, true);
  assert.deepEqual(f.current, before);
  assert.deepEqual(f.writes, [{ workspaceId: 'bot', modelPolicy: { ...before.modelPolicy, overrides: {
    ...before.modelPolicy.overrides, project_agent: { mode: 'fixed', modelProviderId: 'm', reasoningEffort: 'high' } } } }]);
  assert.equal(result.profile.autonomyPolicy, before.autonomyPolicy);
  assert.equal(result.profile.acceptancePolicy, before.acceptancePolicy);
});
test('extra profile fields, scope changes, invalid effort and ineligible models never write', async () => {
  const f = fixture(), valid = { workspaceId: 'bot', modelProviderId: 'm' };
  for (const request of [null, [], {}, { ...valid, displayName: 'renamed' }, { ...valid, acceptancePolicy: 'auto' },
    { ...valid, modelPolicy: {} }, { ...valid, reasoningEffort: 'unknown' }, { ...valid, reasoningEffort: 5 },
    { ...valid, modelProviderId: 'outside' }, { ...valid, modelProviderId: 'missing' }]) {
    assert.equal((await f.update(request)).ok, false);
  }
  f.result.modelOptions[0].available = false;
  assert.equal((await f.update(valid)).code, 'MODEL_UNAVAILABLE');
  f.result.item.profile.status = 'archived';
  assert.equal((await f.update(valid)).code, 'NOT_FOUND');
  assert.equal(f.writes.length, 0);
});
test('default effort comes from the chosen model; disabled and failed saves propagate', async () => {
  const f = fixture();
  assert.equal((await f.update({ workspaceId: 'bot', modelProviderId: 'm' })).profile.modelPolicy.overrides.project_agent.reasoningEffort, 'low');
  f.result.ok = false; f.result.code = 'DISABLED';
  assert.equal((await f.update({ workspaceId: 'bot', modelProviderId: 'm' })).code, 'DISABLED');
  const failure = createBotModelSelectionUpdater({ get: () => ({ ...f.result, ok: true }), updateProfile: () => ({ ok: false, code: 'WRITE_FAILED' }) });
  assert.equal((await failure({ workspaceId: 'bot', modelProviderId: 'm' })).code, 'WRITE_FAILED');
});
