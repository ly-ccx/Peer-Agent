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
