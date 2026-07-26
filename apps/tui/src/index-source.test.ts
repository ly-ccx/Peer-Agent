import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8');

describe('TUI entry provider wiring', () => {
  test('defines the initial provider before constructing the chat model', () => {
    const providerDefinition = indexSource.indexOf(
      'const provider = sharedMetadata ? sharedProvider(modelConfig.providerId) : undefined;',
    );
    const modelConstruction = indexSource.indexOf('const model = provider');

    expect(providerDefinition).toBeGreaterThan(-1);
    expect(modelConstruction).toBeGreaterThan(providerDefinition);
    expect(indexSource).toContain(
      'getProvider: () => sharedMetadata\n        ? sharedProvider(modelSelection.getSelection().providerId)\n        : provider',
    );
  });
});
