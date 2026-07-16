import { describe, expect, test } from 'bun:test';

import {
  createTuiModelSelectionControl,
  modelPickerItems,
  modelSelectionLabel,
} from './tui-model-selection.ts';

describe('TUI model selection', () => {
  test('only exposes available catalog-backed model and effort combinations', () => {
    const control = createTuiModelSelectionControl({
      providerId: 'chatgpt',
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 SOL',
      reasoningEffort: 'high',
      supportedReasoningEfforts: ['low', 'high', 'xhigh'],
    });

    expect(modelPickerItems(control)).toEqual([
      { providerId: 'chatgpt', modelId: 'gpt-5.6-sol', reasoningEffort: 'low' },
      { providerId: 'chatgpt', modelId: 'gpt-5.6-sol', reasoningEffort: 'high' },
      { providerId: 'chatgpt', modelId: 'gpt-5.6-sol', reasoningEffort: 'xhigh' },
    ]);
    expect(modelSelectionLabel(control, control.getSelection())).toBe('GPT-5.6 SOL · high');
  });

  test('lists and switches across configured providers', () => {
    const control = createTuiModelSelectionControl({
      providerId: 'credential-a',
      modelId: 'model-a',
      displayName: 'Model A',
      catalog: [
        {
          providerId: 'credential-a',
          modelId: 'model-a',
          displayName: 'Model A · Provider A',
          supportsTools: true,
          supportedReasoningEfforts: ['default'],
          defaultReasoningEffort: 'default',
          available: true,
        },
        {
          providerId: 'credential-b',
          modelId: 'model-b',
          displayName: 'Model B · Provider B',
          supportsTools: true,
          supportedReasoningEfforts: ['default', 'high'],
          defaultReasoningEffort: 'default',
          available: true,
        },
      ],
    });

    expect(modelPickerItems(control)).toEqual([
      { providerId: 'credential-a', modelId: 'model-a', reasoningEffort: 'default' },
      { providerId: 'credential-b', modelId: 'model-b', reasoningEffort: 'default' },
      { providerId: 'credential-b', modelId: 'model-b', reasoningEffort: 'high' },
    ]);
    control.setSelection({
      providerId: 'credential-b', modelId: 'model-b', reasoningEffort: 'high',
    });
    expect(control.getSelection()).toEqual({
      providerId: 'credential-b', modelId: 'model-b', reasoningEffort: 'high',
    });
    expect(modelSelectionLabel(control, control.getSelection())).toBe('Model B · Provider B · high');
  });

  test('rejects a model or effort that is not in the runtime catalog', () => {
    const control = createTuiModelSelectionControl({
      providerId: 'openai',
      modelId: 'gpt-test',
      displayName: 'GPT Test',
      supportedReasoningEfforts: ['default', 'high'],
    });

    expect(() => control.setSelection({
      providerId: 'openai', modelId: 'other', reasoningEffort: 'high',
    })).toThrow('unavailable');
    expect(() => control.setSelection({
      providerId: 'openai', modelId: 'gpt-test', reasoningEffort: 'xhigh',
    })).toThrow('unavailable');
  });
});
