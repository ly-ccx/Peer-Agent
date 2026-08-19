import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const runtimeSource = readFileSync(new URL('./tui-runtime.ts', import.meta.url), 'utf8');

describe('TUI runtime provider wiring', () => {
  test('defines the initial provider before constructing the chat model', () => {
    const providerDefinition = runtimeSource.indexOf(
      'const provider = sharedMetadata ? sharedProvider(modelConfig.providerId) : undefined;',
    );
    const modelConstruction = runtimeSource.indexOf('const model = provider');

    expect(providerDefinition).toBeGreaterThan(-1);
    expect(modelConstruction).toBeGreaterThan(providerDefinition);
    expect(runtimeSource).toContain(
      'getProvider: () => sharedMetadata\n          ? sharedProvider(modelSelection.getSelection().providerId)\n          : provider',
    );
  });
});
