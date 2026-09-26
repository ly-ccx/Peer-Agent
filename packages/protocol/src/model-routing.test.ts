import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveRoleModel,
  type CatalogModel,
  type ModelRoutingSettings,
  type RoleSetting,
} from './model-routing.ts';

function model(overrides: Partial<CatalogModel> & Pick<CatalogModel, 'modelProviderId'>): CatalogModel {
  const modelId = overrides.modelId ?? overrides.modelProviderId.split('/').at(-1) ?? overrides.modelProviderId;
  return {
    providerId: overrides.providerId ?? overrides.modelProviderId.split('/')[0] ?? 'p',
    modelId,
    family: overrides.family ?? 'family-a',
    tools: overrides.tools ?? true,
    vision: overrides.vision ?? false,
    structured: overrides.structured ?? false,
    contextTokens: overrides.contextTokens ?? 32_000,
    local: overrides.local ?? false,
    modelProviderId: overrides.modelProviderId,
    ...(overrides.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
  };
}

const catalog: CatalogModel[] = [
  model({ modelProviderId: 'cloud/strong', family: 'family-a', tools: true }),
  model({ modelProviderId: 'cloud/fast', family: 'family-b', tools: true }),
  model({ modelProviderId: 'cloud/blind', family: 'family-a', tools: false, vision: false }),
  model({ modelProviderId: 'cloud/vision', family: 'family-v', tools: false, vision: true }),
  model({ modelProviderId: 'local/vision', providerId: 'local', family: 'family-local', tools: false, vision: true, local: true }),
  model({ modelProviderId: 'cloud/short', family: 'family-b', tools: true, contextTokens: 1_000 }),
  model({ modelProviderId: 'cloud/structured', family: 'family-c', tools: false, structured: true }),
];

function routing(roleSetting?: RoleSetting, extra: Partial<ModelRoutingSettings> = {}): ModelRoutingSettings {
  return {
    tiers: {
      strong: { primary: 'cloud/strong', fallbacks: ['cloud/fast'] },
      fast: { primary: 'cloud/fast' },
      vision: { primary: 'cloud/blind' },
      economy: { primary: 'cloud/strong' },
    },
    roles: roleSetting ? { project_agent: roleSetting } : {},
    verifierPreferDifferentFamily: true,
    ...extra,
  };
}

test('capability and scope filters do not fall through to a later layer', () => {
  const incapable = resolveRoleModel({
    role: 'project_agent',
    catalog,
    routing: routing({ mode: 'fixed', modelProviderId: 'cloud/strong' }),
    taskOverride: { mode: 'fixed', modelProviderId: 'cloud/blind' },
  });
  assert.equal(incapable.ok, false);
  if (!incapable.ok) {
    assert.equal(incapable.reason, 'capability');
    assert.equal(incapable.missing, '没有满足该角色能力要求的模型');
  }

  const outOfScope = resolveRoleModel({
    role: 'session_worker',
    catalog,
    routing: routing(),
    requestPreference: { modelProviderId: 'cloud/strong' },
    projectPolicy: { scope: { modelProviderIds: ['cloud/fast'] } },
    taskOverride: { mode: 'fixed', modelProviderId: 'cloud/fast' },
  });
  assert.equal(outOfScope.ok, false);
  if (!outOfScope.ok) {
    assert.equal(outOfScope.reason, 'scope');
    assert.equal(outOfScope.missing, '本项目的模型范围里没有满足该角色要求的模型');
  }
});

test('verifier prefers a different family and may fall back inside the same layer', () => {
  const different = resolveRoleModel({
    role: 'verifier',
    catalog,
    routing: {
      ...routing({ mode: 'tier', tier: 'strong' }, { verifierPreferDifferentFamily: true }),
      roles: { verifier: { mode: 'tier', tier: 'strong' } },
    },
    workerModel: { family: 'family-a' },
  });
  assert.equal(different.ok, true);
  if (different.ok) {
    assert.equal(different.selection.modelProviderId, 'cloud/fast');
    assert.equal(different.sameFamilyAsWorker, false);
    assert.equal(different.source, 'global');
  }

  const same = resolveRoleModel({
    role: 'verifier',
    catalog,
    routing: {
      tiers: { strong: { primary: 'cloud/strong' } },
      roles: { verifier: { mode: 'tier', tier: 'strong' } },
      verifierPreferDifferentFamily: true,
    },
    workerModel: { family: 'family-a' },
  });
  assert.equal(same.ok, true);
  if (same.ok) {
    assert.equal(same.selection.modelProviderId, 'cloud/strong');
    assert.equal(same.sameFamilyAsWorker, true);
  }
});

test('an auto-pool request that misses the pool is rejected', () => {
  const rejected = resolveRoleModel({
    role: 'project_agent',
    catalog,
    routing: routing({ mode: 'auto', pool: ['cloud/strong', 'cloud/fast'] }),
    requestPreference: { modelProviderId: 'cloud/vision' },
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason, 'auto_pool');
    assert.equal(rejected.missing, '所选模型不在自动池内');
  }

  const accepted = resolveRoleModel({
    role: 'project_agent',
    catalog,
    routing: routing({ mode: 'auto', pool: ['cloud/fast'] }),
    requestPreference: { modelProviderId: 'cloud/fast' },
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.source, 'auto');
    assert.equal(accepted.selection.modelProviderId, 'cloud/fast');
  }
});

test('an empty candidate set names what is missing', () => {
  const empty = resolveRoleModel({
    role: 'project_agent',
    catalog,
    routing: routing(),
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) {
    assert.equal(empty.reason, 'empty');
    assert.equal(empty.missing, '没有可用的模型');
  }

  const visual = resolveRoleModel({
    role: 'visual_verifier',
    catalog,
    routing: {
      tiers: { vision: { primary: 'cloud/blind' } },
      roles: { visual_verifier: { mode: 'tier', tier: 'vision' } },
      verifierPreferDifferentFamily: false,
    },
  });
  assert.equal(visual.ok, false);
  if (!visual.ok) {
    assert.equal(visual.reason, 'capability');
    assert.equal(visual.missing, '没有能看图的模型');
  }

  const localVision = resolveRoleModel({
    role: 'visual_verifier',
    catalog,
    routing: {
      tiers: { vision: { primary: 'cloud/vision' } },
      roles: { visual_verifier: { mode: 'tier', tier: 'vision' } },
      verifierPreferDifferentFamily: false,
    },
    projectPolicy: { scope: { localOnly: true } },
  });
  assert.equal(localVision.ok, false);
  if (!localVision.ok) {
    assert.equal(localVision.missing, '本项目只允许本地模型，但没有能看图的本地模型');
  }
});

test('a missing tier binding falls through, and a spend cap does not reject', () => {
  const resolved = resolveRoleModel({
    role: 'explorer',
    catalog,
    routing: {
      tiers: { strong: { primary: 'cloud/strong' } },
      roles: {
        explorer: { mode: 'fixed', modelProviderId: 'cloud/strong' },
      },
      verifierPreferDifferentFamily: false,
      dailySpendCapUsd: 0,
    },
    projectPolicy: {
      overrides: { explorer: { mode: 'tier', tier: 'economy' } },
    },
    requiredContextTokens: 4_000,
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.selection.modelProviderId, 'cloud/strong');
    assert.equal(resolved.source, 'global');
  }

  const short = resolveRoleModel({
    role: 'explorer',
    catalog,
    routing: {
      tiers: {},
      roles: { explorer: { mode: 'fixed', modelProviderId: 'cloud/short' } },
      verifierPreferDifferentFamily: false,
    },
  });
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.reason, 'capability');
});
