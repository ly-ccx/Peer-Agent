import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBotProfileStore } from '@peer-agent/runtime-node';
import { projectBotModelViews } from './model-controls.mjs';
import { profilePolicyPatch } from './profile-policy.mjs';

const model = { id: 'm', model: 'test', apiKeyConfigured: true, supportsTools: true,
  supportsReasoning: true, reasoningEffortLevels: ['low', 'high'], defaultEffort: 'low' };

test('bot projection resolves inherited model and filters role capabilities and scope', () => {
  const providers = [model, { ...model, id: 'vision', supportsVision: true }, { ...model, id: 'unavailable', apiKeyConfigured: false }];
  const views = projectBotModelViews({ providers });
  assert.equal(views.project_agent.resolution.selection.modelProviderId, 'm');
  assert.equal(views.project_agent.resolution.selection.reasoningEffort, 'low');
  assert.deepEqual(views.visual_verifier.eligibleModelIds, ['vision']);
  const restricted = projectBotModelViews({ providers, projectPolicy: { scope: { modelProviderIds: ['vision'] } } });
  assert.deepEqual(restricted.project_agent.eligibleModelIds, ['vision']);
  assert.equal(restricted.project_agent.resolution.ok, false);
});

test('profile effort is validated before any write and persists across restart', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-model-profile-'));
  try {
    const store = createBotProfileStore({ rootDir: home });
    store.create({ workspaceId: 'workspace', displayName: 'test', agentConversationId: 'c' });
    const policy = { overrides: { project_agent: { mode: 'fixed', modelProviderId: 'm', reasoningEffort: 'high' } } };
    const valid = profilePolicyPatch({ modelPolicy: policy }, [model]);
    assert.equal(valid.ok, true);
    assert.equal(store.save({ ...store.read('workspace'), ...valid.patch }).ok, true);
    const reopened = createBotProfileStore({ rootDir: home });
    assert.equal(reopened.read('workspace').modelPolicy.overrides.project_agent.reasoningEffort, 'high');
    for (const effort of ['max', 'bogus']) {
      const invalid = profilePolicyPatch({ displayName: 'wrong', modelPolicy: { overrides: { project_agent: { mode: 'fixed', modelProviderId: 'm', reasoningEffort: effort } } } }, [model]);
      assert.equal(invalid.ok, false);
      assert.equal(invalid.code, 'INVALID_REASONING_EFFORT');
    }
    assert.equal(reopened.read('workspace').modelPolicy.overrides.project_agent.reasoningEffort, 'high');
    assert.equal(profilePolicyPatch({ modelPolicy: policy }, [{ ...model, supportsReasoning: false }]).ok, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
