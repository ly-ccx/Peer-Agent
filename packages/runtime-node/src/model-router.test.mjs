import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDefaultModelRouting,
  evaluateRoleSpendCap,
  providerFamily,
  resolveRoleRoute,
  resolveStoredModelRouting,
} from './model-router.mjs';

function provider(overrides) {
  return {
    enabled: true,
    apiKeyConfigured: true,
    supportsVision: false,
    contextWindow: 32_000,
    ...overrides,
  };
}

const textModel = provider({
  id: 'text-default',
  provider: 'openai',
  groupId: 'openai-group',
  model: 'text',
  isDefault: true,
});
const visionModel = provider({
  id: 'vision-model',
  provider: 'anthropic',
  groupId: 'anthropic-group',
  model: 'vision',
  supportsVision: true,
  isDefault: false,
});

test('provider family prefers provider type, then group id', () => {
  assert.equal(providerFamily({ provider: 'OpenAI', groupId: 'group-a' }), 'openai');
  assert.equal(providerFamily({ providerType: 'Anthropic', provider: 'openai' }), 'anthropic');
  assert.equal(providerFamily({ groupId: 'local-group' }), 'local-group');
});

test('one usable model keeps explorer, verifier, and visual review on that model', () => {
  const only = provider({
    id: 'only-model',
    provider: 'openai',
    model: 'only',
    isDefault: true,
    supportsVision: true,
  });
  for (const role of ['explorer', 'verifier', 'visual_verifier']) {
    const resolved = resolveRoleRoute({
      role,
      providers: [only],
      workerModelProviderId: 'only-model',
    });
    assert.equal(resolved.ok, true, role);
    assert.equal(resolved.selection.modelProviderId, 'only-model');
  }
  const verifier = resolveRoleRoute({
    role: 'verifier',
    providers: [only],
    workerModelProviderId: 'only-model',
  });
  assert.equal(verifier.sameFamilyAsWorker, true);
});

test('several models keep text roles on the default and visual review on a vision model', () => {
  const explorer = resolveRoleRoute({ role: 'explorer', providers: [textModel, visionModel] });
  const verifier = resolveRoleRoute({
    role: 'verifier',
    providers: [textModel, visionModel],
    workerModelProviderId: 'text-default',
  });
  const visual = resolveRoleRoute({ role: 'visual_verifier', providers: [textModel, visionModel] });
  assert.equal(explorer.selection.modelProviderId, 'text-default');
  assert.equal(verifier.selection.modelProviderId, 'text-default');
  assert.equal(verifier.sameFamilyAsWorker, true);
  assert.equal(visual.selection.modelProviderId, 'vision-model');
  assert.deepEqual(explorer.candidateIds, ['text-default']);
});

test('verifier prefers a different family and records a same-family fallback', () => {
  const other = provider({
    id: 'other-family',
    provider: 'anthropic',
    model: 'other',
    supportsVision: false,
  });
  const different = resolveRoleRoute({
    role: 'verifier',
    providers: [textModel, other],
    workerModelProviderId: 'text-default',
    routing: {
      tiers: { strong: { primary: 'text-default', fallbacks: ['other-family'] } },
      roles: { verifier: { mode: 'tier', tier: 'strong' } },
      verifierPreferDifferentFamily: true,
    },
  });
  assert.equal(different.ok, true);
  assert.equal(different.selection.modelProviderId, 'other-family');
  assert.equal(different.sameFamilyAsWorker, false);
  assert.deepEqual(different.candidateIds, ['other-family', 'text-default']);

  const same = resolveRoleRoute({
    role: 'verifier',
    providers: [textModel],
    workerModelProviderId: 'text-default',
    routing: {
      tiers: { strong: { primary: 'text-default', fallbacks: [] } },
      roles: { verifier: { mode: 'tier', tier: 'strong' } },
      verifierPreferDifferentFamily: true,
    },
  });
  assert.equal(same.selection.modelProviderId, 'text-default');
  assert.equal(same.sameFamilyAsWorker, true);
});

test('visual review fails with a structured reason when nothing can see images', () => {
  const resolved = resolveRoleRoute({
    role: 'visual_verifier',
    providers: [textModel],
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.missing, '没有能看图的模型');
  assert.deepEqual(resolved.candidateIds, []);
});

test('an explicit request outside project scope does not fall through', () => {
  const resolved = resolveRoleRoute({
    role: 'explorer',
    providers: [textModel, visionModel],
    requestPreference: { modelProviderId: 'vision-model' },
    projectPolicy: { scope: { modelProviderIds: ['text-default'] } },
    taskOverride: { mode: 'fixed', modelProviderId: 'text-default' },
  });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, 'scope');
});

test('spend cap blocks automatic roles and still resolves the project agent', () => {
  assert.deepEqual(evaluateRoleSpendCap({ role: 'explorer', spentUsd: 2, capUsd: 1 }), {
    exceeded: true,
    blocks: true,
  });
  assert.equal(evaluateRoleSpendCap({ role: 'project_agent', spentUsd: 2, capUsd: 1 }).blocks, false);
  const blocked = resolveRoleRoute({
    role: 'explorer',
    providers: [textModel],
    routing: { dailySpendCapUsd: 1 },
    spentUsd: 1,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'spend_cap_reached');
  const essential = resolveRoleRoute({
    role: 'project_agent',
    providers: [textModel],
    routing: { dailySpendCapUsd: 1 },
    spentUsd: 5,
  });
  assert.equal(essential.ok, true);
  assert.equal(essential.spendExceeded, true);
  assert.equal(essential.selection.modelProviderId, 'text-default');
});

test('stored routing overrides a tier without persisting computed defaults', () => {
  const defaults = buildDefaultModelRouting([textModel, visionModel]);
  assert.equal(defaults.tiers.strong.primary, 'text-default');
  assert.equal(defaults.tiers.vision.primary, 'vision-model');
  assert.equal(defaults.roles.explorer.tier, 'economy');
  const merged = resolveStoredModelRouting({
    tiers: { strong: { primary: 'vision-model', fallbacks: [] } },
  }, [textModel, visionModel]);
  assert.equal(merged.tiers.strong.primary, 'vision-model');
  assert.equal(merged.tiers.economy.primary, 'text-default');
  assert.equal(merged.verifierPreferDifferentFamily, true);
});
