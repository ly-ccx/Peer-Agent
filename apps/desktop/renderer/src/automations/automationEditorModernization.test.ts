import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(name, import.meta.url), 'utf8');

test('Automation create path is prompt-first with generated plan after detection', async () => {
  const center = await read('./AutomationCenter.tsx');
  const i18n = await read('./automationI18n.ts');

  assert.equal(center.includes('automation-stepper'), false);
  assert.equal(center.includes('EditorStep'), false);
  assert.match(center, /inferAutomationDraftFromPrompt/);
  assert.match(center, /promptFirstDetail/);
  assert.match(center, /generatedPlan/);
  assert.match(center, /const runDetection = async/);
  assert.match(center, /clientApi\.llmComplete/);
  assert.match(center, /buildAutomationDetectionPrompt/);
  assert.match(center, /parseLlmAutomationDetectionText/);
  assert.match(center, /applyDetectionPatch/);
  assert.match(center, /return applyInference\(prompt, force\)/);
  assert.match(center, /setConfirmOpen\(true\)/);
  assert.match(center, /onBlur=\{onPromptBlur\}/);
  assert.match(center, /detected \|\| editing/);
  assert.match(center, /onSave: \(draft\?: Draft\) => void/);
  assert.match(center, /draft\.prompt\.trim\(\)/);
  // name is no longer required for enable validity
  assert.equal(center.includes('draft.name.trim()\n    && draft.prompt.trim()'), false);

  for (const key of [
    'promptFirstDetail', 'promptFirstPlaceholder', 'detectFromPrompt',
    'generatedPlan', 'generatedPlanDetail', 'createAndEnable', 'advancedSettings',
  ]) {
    assert.equal(i18n.includes(`${key}:`), true, `missing i18n key ${key}`);
  }
});

test('English and Chinese prompt-first keys stay aligned', async () => {
  const i18n = await read('./automationI18n.ts');
  for (const key of ['promptFirstDetail', 'detectFromPrompt', 'generatedPlan']) {
    assert.equal((i18n.match(new RegExp(`${key}:`, 'g')) || []).length, 2, key);
  }
});
