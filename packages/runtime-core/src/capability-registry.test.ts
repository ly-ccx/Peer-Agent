import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CapabilityRegistryError,
  createCapabilityProviderRegistry,
  type CapabilityProvider,
} from './index.ts';

const context = {
  runId: 'run_test',
};

function createProvider(overrides: Partial<CapabilityProvider> = {}): CapabilityProvider {
  return {
    providerId: 'local.test',
    capabilityIds: ['local.test.echo'],
    async execute(request) {
      return {
        toolCallId: request.toolCall.toolCallId,
        capabilityId: request.capabilityId,
        status: 'completed',
        outputPreview: request.input,
      };
    },
    ...overrides,
  };
}

test('registry routes direct capability ids', async () => {
  const registry = createCapabilityProviderRegistry([createProvider()]);
  assert.equal(registry.hasCapability('local.test.echo'), true);
  assert.deepEqual(registry.listCapabilityIds(), ['local.test.echo']);
  assert.deepEqual(registry.listProviderIds(), ['local.test']);

  const result = await registry.execute(
    {
      capabilityId: 'local.test.echo',
      input: { message: 'hello' },
      toolCall: {
        toolCallId: 'call_1',
        capabilityId: 'local.test.echo',
        input: { message: 'hello' },
      },
    },
    context,
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.outputPreview, { message: 'hello' });
});

test('registry routes capability prefixes', () => {
  const registry = createCapabilityProviderRegistry([
    createProvider({
      providerId: 'mcp',
      capabilityIds: undefined,
      capabilityPrefix: 'mcp__',
    }),
  ]);

  assert.equal(registry.hasCapability('mcp__server__tool'), true);
  assert.equal(registry.getProvider('mcp__server__tool')?.providerId, 'mcp');
});

test('registry rejects duplicate provider and capability ids', () => {
  assert.throws(
    () => createCapabilityProviderRegistry([createProvider(), createProvider()]),
    (error) => error instanceof CapabilityRegistryError && error.code === 'duplicate_provider',
  );

  assert.throws(
    () =>
      createCapabilityProviderRegistry([
        createProvider({ providerId: 'a' }),
        createProvider({ providerId: 'b' }),
      ]),
    (error) => error instanceof CapabilityRegistryError && error.code === 'duplicate_capability',
  );
});
