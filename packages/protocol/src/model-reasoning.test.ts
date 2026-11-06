import assert from 'node:assert/strict';
import test from 'node:test';
import { modelReasoningLevels, modelDefaultReasoningEffort } from './model-reasoning.ts';
import { resolveRoleModel } from './model-routing.ts';

test('effort choices use declarations without inventing capabilities', () => {
  assert.deepEqual(modelReasoningLevels({ supportsReasoning: false, reasoningEffortLevels: ['high'] }), []);
  assert.deepEqual(modelReasoningLevels({ supportsReasoning: true }), []);
  assert.deepEqual(modelReasoningLevels({ reasoningEffortLevels: ['max', 'high', 'bogus', 'high', 'low'] }), ['low', 'high', 'max']);
  assert.equal(modelDefaultReasoningEffort({ reasoningEffortLevels: ['low', 'medium', 'high'] }), 'medium');
  assert.equal(modelDefaultReasoningEffort({ reasoningEffortLevels: ['low', 'high'], defaultEffort: 'low' }), 'low');
});

test('fixed effort enters selection only when the chosen model supports it', () => {
  const request = { role: 'project_agent' as const,
    catalog: [{ modelProviderId: 'm', providerId: 'p', modelId: 'model', family: 'f', tools: true, reasoningEffortLevels: ['low', 'high'] as const }],
    routing: { tiers: {}, roles: {}, verifierPreferDifferentFamily: false },
    projectPolicy: { overrides: { project_agent: { mode: 'fixed' as const, modelProviderId: 'm', reasoningEffort: 'high' as const } } },
  };
  const result = resolveRoleModel(request);
  assert.equal(result.ok && result.selection.reasoningEffort, 'high');
  const rejected = resolveRoleModel({ ...request, projectPolicy: { overrides: { project_agent: { ...request.projectPolicy.overrides.project_agent, reasoningEffort: 'max' } } } });
  assert.equal(!rejected.ok && rejected.reason, 'reasoning');
});

test('tier and auto role efforts preserve model routing, scope precedence and unsupported failures', () => {
  const catalog = [{ modelProviderId: 'm', providerId: 'p', modelId: 'model', family: 'f', tools: true,
    reasoningEffort: 'low', reasoningEffortLevels: ['low', 'high'] as const }];
  for (const setting of [{ mode: 'tier' as const, tier: 'fast' as const }, { mode: 'auto' as const, pool: ['m'] }]) {
    const routing = { tiers: { fast: { primary: 'm' } }, roles: { project_agent: { ...setting, reasoningEffort: 'high' as const } }, verifierPreferDifferentFamily: false };
    const request = { role: 'project_agent' as const, catalog, routing };
    const selected = resolveRoleModel(request);
    assert.equal(selected.ok && selected.selection.modelProviderId, 'm');
    assert.equal(selected.ok && selected.selection.reasoningEffort, 'high');
    const overridden = resolveRoleModel({ ...request, projectPolicy: { overrides: { project_agent: setting } } });
    assert.equal(overridden.ok && overridden.selection.reasoningEffort, 'low', 'higher-scope settings do not borrow a global override');
    const incompatible = resolveRoleModel({ ...request, routing: { ...routing,
      roles: { project_agent: { ...setting, reasoningEffort: 'max' as const } } } });
    assert.equal(!incompatible.ok && incompatible.reason, 'reasoning');
  }
});
