import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRuntimeModelSelectionAvailable,
  normalizeModelReasoningEffort,
  normalizeRuntimePermissionPolicy,
  type RuntimeModelCatalogEntry,
} from './model-catalog.ts';

const model: RuntimeModelCatalogEntry = {
  providerId: 'openai',
  modelId: 'gpt-5.6-sol',
  displayName: 'GPT-5.6 SOL',
  contextWindow: 353_000,
  supportsTools: true,
  supportedReasoningEfforts: ['low', 'default', 'high', 'xhigh'],
  defaultReasoningEffort: 'default',
  available: true,
};

test('normalizes reasoning effort against model capability', () => {
  assert.equal(normalizeModelReasoningEffort(model, 'high'), 'high');
  assert.equal(normalizeModelReasoningEffort(model, 'off'), 'default');
  assert.equal(normalizeModelReasoningEffort(model, undefined), 'default');
});

test('requires an available model and supported effort', () => {
  assert.equal(isRuntimeModelSelectionAvailable([model], {
    providerId: 'openai',
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
  }), true);
  assert.equal(isRuntimeModelSelectionAvailable([model], {
    providerId: 'openai',
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'off',
  }), false);
  assert.equal(isRuntimeModelSelectionAvailable([{ ...model, available: false }], {
    providerId: 'openai',
    modelId: 'gpt-5.6-sol',
    reasoningEffort: 'high',
  }), false);
});

test('defaults unknown permission policies to ask', () => {
  assert.equal(normalizeRuntimePermissionPolicy('read-only'), 'read-only');
  assert.equal(normalizeRuntimePermissionPolicy('workspace-write'), 'workspace-write');
  assert.equal(normalizeRuntimePermissionPolicy('invalid'), 'ask');
  assert.equal(normalizeRuntimePermissionPolicy(undefined), 'ask');
});
