import { expect, test } from 'bun:test';
import type { SharedModelMetadata, RuntimeModelCatalogEntry } from '@peer-agent/runtime-node';
import { createTuiModelSelectionControl, createTuiContextSelectionControl } from '../tui-model-selection.ts';
import { acpModelId, createAcpModelConfig } from './models.ts';
import { createPeerAcpAgent } from './agent.ts';

function fixture(reasoning = true, capacity = true) {
  const catalog: RuntimeModelCatalogEntry[] = [{ providerId: 'p', modelId: 'm', displayName: 'M', available: true, supportsTools: true, contextWindow: 8192, supportedReasoningEfforts: reasoning ? ['low', 'high'] : ['default'], defaultReasoningEffort: reasoning ? 'low' : 'default' }];
  const metadata: SharedModelMetadata[] = [{ source: 'desktop-default', providerId: 'p', credentialId: 'p', displayName: 'P', model: 'm', baseUrl: '', authMethod: 'api_key', credentialStored: true, supportsReasoning: reasoning, configFile: '', supportedReasoningEfforts: catalog[0]!.supportedReasoningEfforts, defaultReasoningEffort: catalog[0]!.defaultReasoningEffort, ...(capacity ? { modelOptions: [{ id: 'capacity', label: 'Capacity', kind: 'select' as const, defaultValue: 'small', choices: [{ value: 'small', label: '32K', contextWindow: 32768 }, { value: 'large', label: '128K', contextWindow: 131072 }] }] } : {}) }];
  const models = createTuiModelSelectionControl({ providerId: 'p', modelId: 'm', displayName: 'M', reasoningEffort: catalog[0]!.defaultReasoningEffort, catalog });
  const context = createTuiContextSelectionControl(models, metadata);
  return { models, context, metadata, config: createAcpModelConfig(models, () => {}, metadata, false, context) };
}

for (const configId of ['reasoning_effort', 'context_window']) for (const valid of [true, false]) for (const busy of [true, false]) for (const count of [1, 2]) {
  test(`option guard / ${configId} / valid=${valid} / busy=${busy} / sessions=${count}`, async () => {
    const fixtures: ReturnType<typeof fixture>[] = [];
    const peer = createPeerAcpAgent(async () => {
      const state = fixture(); fixtures.push(state);
      return { ...state.config, async prompt(_text, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }, async dispose() {} };
    }, async () => {});
    await peer.agent.initialize({ protocolVersion: 1 });
    const sessions = [];
    for (let i = 0; i < count; i++) sessions.push(await peer.agent.newSession({ cwd: process.cwd(), mcpServers: [] }));
    const sessionId = sessions[0]!.sessionId;
    const before = fixtures.map((state) => state.config.getConfigOptions());
    const turn = busy ? peer.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'wait' }] }) : undefined;
    try {
      const value = valid ? (configId === 'reasoning_effort' ? 'high' : JSON.stringify('large')) : 'invalid';
      const changed = peer.agent.setSessionConfigOption!({ sessionId, configId, value });
      if (busy || !valid) {
        await expect(changed).rejects.toThrow(busy ? 'active' : 'Unsupported');
        expect(fixtures[0]!.config.getConfigOptions()).toEqual(before[0]);
      } else {
        expect((await changed).configOptions.find((option) => option.id === configId)?.currentValue).toBe(value);
      }
      if (count === 2) expect(fixtures[1]!.config.getConfigOptions()).toEqual(before[1]);
    } finally { await peer.close(); await turn; }
  });
}

for (const keepEffort of [false, true]) for (const keepCapacity of [false, true]) {
  test(`model switch / keep effort=${keepEffort} / keep capacity=${keepCapacity}`, () => {
    const base = fixture();
    const first = base.models.catalog[0]!;
    const target: RuntimeModelCatalogEntry = { ...first, modelId: 'next', supportedReasoningEfforts: keepEffort ? ['low', 'high'] : ['default'], defaultReasoningEffort: keepEffort ? 'low' : 'default' };
    const definition = base.metadata[0]!.modelOptions![0]!;
    const metadata: SharedModelMetadata[] = [...base.metadata, { ...base.metadata[0]!, model: 'next', modelOptions: [{ ...definition, choices: keepCapacity ? definition.choices : [{ value: 'other', label: '64K', contextWindow: 65536 }], defaultValue: keepCapacity ? 'small' : 'other' }] }];
    const models = createTuiModelSelectionControl({ ...base.models.getSelection(), displayName: 'M', catalog: [first, target] });
    const context = createTuiContextSelectionControl(models, metadata);
    const config = createAcpModelConfig(models, () => {}, metadata, false, context);
    config.setConfigOption('reasoning_effort', 'high');
    config.setConfigOption('context_window', JSON.stringify('large'));
    config.setConfigOption('model', acpModelId('p', 'next'));
    expect(models.getSelection().reasoningEffort).toBe(keepEffort ? 'high' : 'default');
    expect(context.getContextWindow()).toBe(keepCapacity ? 131072 : 65536);
  });
}

test('failed model persistence preserves selected effort and capacity', () => {
  const base = fixture();
  const first = base.models.catalog[0]!;
  const models = createTuiModelSelectionControl({ ...base.models.getSelection(), displayName: 'M', catalog: [first, { ...first, modelId: 'next' }] });
  const context = createTuiContextSelectionControl(models, base.metadata);
  context.setValue('large');
  const config = createAcpModelConfig(models, () => { throw new Error('disk failure'); }, base.metadata, false, context);
  const before = config.getConfigOptions();
  expect(() => config.setConfigOption('model', acpModelId('p', 'next'))).toThrow('disk failure');
  expect(config.getConfigOptions()).toEqual(before);
});

for (const support of [false, undefined]) {
  test(`reasoning capability ${support} overrides multi-level catalog`, () => {
    const { models, context, metadata } = fixture();
    const config = createAcpModelConfig(models, () => {}, [{ ...metadata[0]!, supportsReasoning: support }], false, context);
    expect(config.getConfigOptions().some((option) => option.id === 'reasoning_effort')).toBe(false);
    expect(() => config.setConfigOption('reasoning_effort', 'high')).toThrow();
    expect(models.getSelection().reasoningEffort).toBe('low');
  });
}

for (const reasoning of [false, true]) for (const capacity of [false, true]) {
  test(`capability matrix / reasoning=${reasoning} / capacity=${capacity}`, () => {
    const { config, context } = fixture(reasoning, capacity);
    const ids = config.getConfigOptions().map((option) => option.id);
    expect(ids.includes('reasoning_effort')).toBe(reasoning);
    expect(ids.includes('context_window')).toBe(capacity);
    expect(context.getContextWindow()).toBe(capacity ? 32768 : 8192);
  });
}
for (const effort of ['low', 'high'] as const) for (const capacity of ['small', 'large']) {
  test(`selection cross product / ${effort} / ${capacity}`, () => {
    const first = fixture(); const second = fixture();
    first.config.setConfigOption('reasoning_effort', effort);
    first.config.setConfigOption('context_window', JSON.stringify(capacity));
    expect(first.models.getSelection().reasoningEffort).toBe(effort);
    expect(first.context.getContextWindow()).toBe(capacity === 'small' ? 32768 : 131072);
    expect(second.models.getSelection().reasoningEffort).toBe('low');
    expect(second.context.getContextWindow()).toBe(32768);
    const before = first.config.getConfigOptions();
    expect(() => first.config.setConfigOption('reasoning_effort', 'invalid')).toThrow();
    expect(() => first.config.setConfigOption('context_window', 'invalid')).toThrow();
    expect(first.config.getConfigOptions()).toEqual(before);
  });
}
