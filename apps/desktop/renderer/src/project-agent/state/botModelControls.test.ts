import assert from 'node:assert/strict';
import test from 'node:test';
import { botConfiguredModelSelection, botFixedModelPolicy, botInheritModelPolicy, botModelMenuGroups } from './botModelControls.ts';
import type { ModelRoutingMenuOption, ProjectModelPolicy } from '@peer-agent/protocol';
const model: ModelRoutingMenuOption = { id: 'm', label: 'Model', providerName: 'Channel', groupId: 'p', model: 'model', authMethod: 'api_key', supportsVision: false, supportsTools: true, supportsStructured: true, contextTokens: 1000, available: true, reasoningEffortLevels: ['low', 'high'], defaultReasoningEffort: 'low' };

test('switch and effort pin just one role and preserve scope and other roles', () => {
  const policy: ProjectModelPolicy = { scope: { localOnly: true }, overrides: { verifier: { mode: 'tier', tier: 'strong' } } };
  const selected = botFixedModelPolicy(policy, 'project_agent', model, 'max');
  assert.deepEqual(selected.overrides?.project_agent, { mode: 'fixed', modelProviderId: 'm', reasoningEffort: 'low' });
  const strong = botFixedModelPolicy(selected, 'project_agent', model, 'high');
  assert.deepEqual(strong.overrides?.project_agent, { mode: 'fixed', modelProviderId: 'm', reasoningEffort: 'high' });
  assert.deepEqual(botInheritModelPolicy(strong, 'project_agent'), policy);
});

test('menu shares channel grouping and disables models outside role eligibility', () => {
  const groups = botModelMenuGroups([model, { ...model, id: 'other', available: false }], { resolution: { ok: false, reason: 'scope', missing: '' }, eligibleModelIds: ['m'] }, true);
  assert.equal(groups[0].label, 'Channel');
  assert.equal(groups[0].items[0].disabled, false);
  assert.equal(groups[0].items[1].disabled, true);
});

test('committed fixed model and effort display immediately while eligibility stays authoritative', () => {
  const policy = botFixedModelPolicy(null, 'project_agent', model, 'high');
  const view = { resolution: { ok: false as const, reason: 'empty' as const, missing: '' }, eligibleModelIds: ['m'] };
  assert.deepEqual(botConfiguredModelSelection(policy, 'project_agent', [model], view), { modelProviderId: 'm', reasoningEffort: 'high' });
  assert.equal(botConfiguredModelSelection(policy, 'project_agent', [model], { ...view, eligibleModelIds: [] }), undefined);
  assert.equal(botConfiguredModelSelection(policy, 'project_agent', [{ ...model, available: false }], view), undefined);
  assert.equal(botConfiguredModelSelection({ overrides: { project_agent: { mode: 'fixed', modelProviderId: 'm', reasoningEffort: 'max' } } }, 'project_agent', [model], view), undefined);
});
