import { expect, test } from 'bun:test';
import type { RuntimeModelCatalogEntry } from '@peer-agent/runtime-node';
import { createTuiModelSelectionControl } from '../tui-model-selection.ts';
import { createPeerAcpAgent } from './agent.ts';
import { acpModelId, createAcpModelConfig } from './models.ts';

function control() {
  const catalog: RuntimeModelCatalogEntry[] = ['provider-a', 'provider-b', 'unavailable'].map((providerId) => ({
    providerId, modelId: 'same-model', displayName: 'Same Model', supportsTools: true,
    supportedReasoningEfforts: ['default'], defaultReasoningEffort: 'default', available: providerId !== 'unavailable',
  }));
  return createTuiModelSelectionControl({ providerId: 'provider-a', modelId: 'same-model', displayName: 'Same Model', catalog });
}

test('model list identifies same-name providers and excludes unavailable models', () => {
  const selection = control();
  const config = createAcpModelConfig(selection, () => {});
  expect(config.getConfigOptions()).toEqual([{
    id: 'model', name: 'Model', category: 'model', type: 'select',
    currentValue: acpModelId('provider-a', 'same-model'),
    options: ['provider-a', 'provider-b'].map((providerId) => ({ group: providerId, name: 'Peer', options: [{ value: acpModelId(providerId, 'same-model'), name: 'same-model' }] })),
  }]);
  expect(acpModelId('a/b', 'c')).not.toBe(acpModelId('a', 'b/c'));
  expect(() => config.setConfigOption('model', acpModelId('unavailable', 'same-model'))).toThrow('unavailable');
  expect(() => config.setConfigOption('unknown', acpModelId('provider-b', 'same-model'))).toThrow('Unknown configuration');
  expect(selection.getSelection().providerId).toBe('provider-a');
});

test('persistence failure rolls selection back', () => {
  const selection = control();
  const config = createAcpModelConfig(selection, () => { throw new Error('disk failure'); });
  expect(() => config.setConfigOption('model', acpModelId('provider-b', 'same-model'))).toThrow('disk failure');
  expect(selection.getSelection().providerId).toBe('provider-a');
});

for (const valid of [true, false]) for (const busy of [true, false]) for (const count of [1, 2]) {
  test(`model switch / ${valid ? 'valid' : 'invalid'} / ${busy ? 'busy' : 'idle'} / ${count} sessions`, async () => {
    const controls: ReturnType<typeof control>[] = [];
    const persisted: string[] = [];
    const peer = createPeerAcpAgent(async () => {
      const selection = control(); controls.push(selection);
      return {
        ...createAcpModelConfig(selection, () => { persisted.push(selection.getSelection().providerId); }),
        async prompt(_text, signal) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
        },
        async dispose() {},
      };
    }, async () => {});
    await peer.agent.initialize({ protocolVersion: 1 });
    const sessions = [];
    for (let i = 0; i < count; i++) sessions.push(await peer.agent.newSession({ cwd: process.cwd(), mcpServers: [] }));
    expect(sessions[0]!.configOptions?.[0]?.currentValue).toBe(acpModelId('provider-a', 'same-model'));
    const sessionId = sessions[0]!.sessionId;
    const turn = busy ? peer.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'wait' }] }) : undefined;
    try {
      const changed = peer.agent.setSessionConfigOption!({ sessionId, configId: 'model', value: valid ? acpModelId('provider-b', 'same-model') : 'missing' });
      if (busy || !valid) await expect(changed).rejects.toThrow(busy ? 'active' : 'unavailable');
      else expect((await changed).configOptions[0]?.currentValue).toBe(acpModelId('provider-b', 'same-model'));
      expect(controls[0]!.getSelection().providerId).toBe(valid && !busy ? 'provider-b' : 'provider-a');
      expect(persisted).toEqual(valid && !busy ? ['provider-b'] : []);
      if (count === 2) expect(controls[1]!.getSelection().providerId).toBe('provider-a');
      if (!busy) {
        await expect(peer.agent.setSessionConfigOption!({ sessionId, configId: 'model', type: 'boolean', value: true })).rejects.toThrow('string');
        await expect(peer.agent.setSessionConfigOption!({ sessionId: 'missing', configId: 'model', value: 'missing' })).rejects.toThrow('Unknown session');
      }
    } finally { await peer.close(); await turn; }
  });
}
