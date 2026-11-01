import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleSystemContext, createPromptSourceRegistry, createInputPredictionPromptSource } from '../index.mjs';

test('prediction is an explicit source and ordinary chat does not inherit its role', () => {
  const prediction = assembleSystemContext({ mode: 'input_prediction' }, { registry: createPromptSourceRegistry({ sources: [createInputPredictionPromptSource()] }) });
  assert.match(prediction.rendered, /ORIGINAL HUMAN point of view/);
  assert.match(prediction.rendered, /no tools/);
  assert.match(prediction.rendered, /untrusted factual data/);
  const ordinary = assembleSystemContext({ mode: 'chat' });
  assert.doesNotMatch(ordinary.rendered, /ORIGINAL HUMAN point of view/);
});
