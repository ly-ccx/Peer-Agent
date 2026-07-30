import { describe, expect, test } from 'bun:test';

import {
  buildModelPickerView,
  createTuiModelSelectionControl,
  cycleModelPickerGroup,
  modelPickerItems,
  modelSelectionLabel,
  resolvePersistedModelSelection,
  sessionTopbarModelLabel,
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
    expect(modelSelectionLabel(control, control.getSelection())).toBe('GPT-5.6 SOL · Models · high');
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

  test('groups models by provider and filters by search query', () => {
    const control = createTuiModelSelectionControl({
      providerId: 'credential-a',
      modelId: 'model-a',
      displayName: 'Model A · Provider A',
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
        {
          providerId: 'credential-b',
          modelId: 'model-c',
          displayName: 'Model C · Provider B',
          supportsTools: true,
          supportedReasoningEfforts: ['default'],
          defaultReasoningEffort: 'default',
          available: true,
        },
      ],
    });

    const grouped = buildModelPickerView({
      control,
      current: control.getSelection(),
      activeGroup: 'Provider B',
    });
    expect(grouped.groups).toEqual(['Provider A', 'Provider B']);
    expect(grouped.selectableRows.map((row) => row.label)).toEqual(['Model B', 'Model C']);

    const searched = buildModelPickerView({
      control,
      current: control.getSelection(),
      query: 'model c',
    });
    expect(searched.selectableRows.map((row) => row.label)).toEqual(['Model C']);
    expect(cycleModelPickerGroup(grouped.groups, 'Provider A', 1)).toBe('Provider B');
  });

  test('opens multi-effort models as a second stage instead of flattening every effort', () => {
    const control = createTuiModelSelectionControl({
      providerId: 'credential-b',
      modelId: 'model-b',
      displayName: 'Model B · Provider B',
      catalog: [
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
    const efforts = buildModelPickerView({
      control,
      current: control.getSelection(),
      stage: 'efforts',
      pendingModel: { providerId: 'credential-b', modelId: 'model-b' },
    });
    expect(efforts.stage).toBe('efforts');
    expect(efforts.selectableRows.map((row) => row.label)).toEqual(['default', 'high']);
  });


  test('shows credentialed models from every desktop provider as selectable', () => {
    const control = createTuiModelSelectionControl({
      providerId: 'credential-api',
      modelId: 'model-api',
      displayName: 'Model API · Provider API',
      catalog: [
        {
          providerId: 'credential-api',
          modelId: 'model-api',
          displayName: 'Model API · Provider API',
          supportsTools: true,
          supportedReasoningEfforts: ['default'],
          defaultReasoningEffort: 'default',
          available: true,
        },
        {
          providerId: 'credential-grok',
          modelId: 'grok-4.5',
          displayName: 'grok-4.5 · Grok 官方',
          supportsTools: true,
          supportedReasoningEfforts: ['default'],
          defaultReasoningEffort: 'default',
          available: true,
        },
      ],
    });
    const view = buildModelPickerView({
      control,
      current: control.getSelection(),
      activeGroup: 'Grok 官方',
    });
    expect(view.rows.some((row) => row.label === 'grok-4.5')).toBe(true);
    expect(view.selectableRows.map((row) => row.label)).toEqual(['grok-4.5']);
    expect(view.subtitle).toBe('1/1 runnable');
  });

  test('formats session topbar as PROVIDER / MODEL without reasoning suffix', () => {
    const control = createTuiModelSelectionControl({
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 SOL · OpenAI',
      catalog: [
        {
          providerId: 'openai',
          modelId: 'gpt-5.6-sol',
          displayName: 'GPT-5.6 SOL · OpenAI',
          supportsTools: true,
          supportedReasoningEfforts: ['high'],
          defaultReasoningEffort: 'high',
          available: true,
        },
      ],
      supportedReasoningEfforts: ['high'],
    });

    expect(sessionTopbarModelLabel(control, control.getSelection())).toBe(
      'OPENAI / GPT-5.6-SOL',
    );
    expect(sessionTopbarModelLabel(null, null, 'gpt-5.6-sol')).toBe('GPT-5.6-SOL');
  });

  test('resolves persisted bindings across Desktop id shapes', () => {
    // Mirrors real Desktop data: the primary model row has entryId === groupId,
    // additional models in the same channel carry their own entry uuid.
    const control = createTuiModelSelectionControl({
      providerId: 'group-qoder',
      modelId: 'gm51model',
      displayName: 'GLM-5.2 · Qoder CLI',
      catalog: [
        {
          providerId: 'group-qoder',
          modelId: 'gm51model',
          entryId: 'group-qoder',
          displayName: 'GLM-5.2 · Qoder CLI',
          supportsTools: true,
          supportedReasoningEfforts: ['off', 'default'],
          defaultReasoningEffort: 'default',
          available: true,
        },
        {
          providerId: 'group-qoder',
          modelId: 'ultimate',
          entryId: 'entry-ultimate',
          displayName: 'Ultimate · Qoder CLI',
          supportsTools: true,
          supportedReasoningEfforts: ['off', 'default'],
          defaultReasoningEffort: 'default',
          available: true,
        },
        {
          providerId: 'group-offline',
          modelId: 'model-offline',
          entryId: 'entry-offline',
          displayName: 'Offline · Provider X',
          supportsTools: true,
          supportedReasoningEfforts: ['default'],
          defaultReasoningEffort: 'default',
          available: false,
        },
      ],
    });

    // groupId binding (CLI-written form) resolves exactly.
    expect(resolvePersistedModelSelection(control, {
      providerId: 'group-qoder', modelId: 'ultimate', reasoningEffort: 'off',
    })).toEqual({ providerId: 'group-qoder', modelId: 'ultimate', reasoningEffort: 'off' });

    // Desktop model entry uuid binding maps back to the groupId-keyed entry.
    expect(resolvePersistedModelSelection(control, {
      providerId: 'entry-ultimate', modelId: 'ultimate', reasoningEffort: 'off',
    })).toEqual({ providerId: 'group-qoder', modelId: 'ultimate', reasoningEffort: 'off' });

    // Unsupported persisted effort clamps to the entry default.
    expect(resolvePersistedModelSelection(control, {
      providerId: 'entry-ultimate', modelId: 'ultimate', reasoningEffort: 'xhigh',
    })).toEqual({ providerId: 'group-qoder', modelId: 'ultimate', reasoningEffort: 'default' });

    // Group binding with a drifted model snapshot keeps the provider.
    expect(resolvePersistedModelSelection(control, {
      providerId: 'group-qoder', modelId: 'unknown-model', reasoningEffort: 'default',
    })).toEqual({ providerId: 'group-qoder', modelId: 'gm51model', reasoningEffort: 'default' });

    // Unavailable entries and unknown bindings resolve to null, never throw.
    expect(resolvePersistedModelSelection(control, {
      providerId: 'entry-offline', modelId: 'model-offline', reasoningEffort: 'default',
    })).toBeNull();
    expect(resolvePersistedModelSelection(control, {
      providerId: 'entry-missing', modelId: 'ultimate', reasoningEffort: 'off',
    })).toBeNull();
  });

});
