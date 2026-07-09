import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityRegistryError } from '@peer-agent/runtime-core';
import { createCapabilityProviderRegistry } from './capability-provider-registry.mjs';

function createDesktopProvider(overrides = {}) {
  return {
    providerId: 'desktop.test',
    capabilityIds: ['desktop.test.echo'],
    async executeCapability(request, context) {
      return {
        request,
        context,
        capabilityId: request.call.capabilityId,
        outputPreview: request.call.arguments,
      };
    },
    ...overrides,
  };
}

function createRequest(capabilityId = 'desktop.test.echo', args = { message: 'hello' }) {
  return {
    sessionId: 'session-1',
    call: {
      id: 'call-1',
      capabilityId,
      arguments: args,
    },
  };
}

test('desktop registry keeps the existing direct capability API while using runtime-core', async () => {
  const provider = createDesktopProvider();
  const registry = createCapabilityProviderRegistry({ providers: [provider] });
  const request = createRequest();
  const context = { workspaceRoot: '/tmp/workspace' };

  assert.equal(registry.hasCapability('desktop.test.echo'), true);
  assert.deepEqual(registry.listCapabilityIds(), ['desktop.test.echo']);
  assert.deepEqual(registry.listProviderIds(), ['desktop.test']);
  assert.equal(registry.getProvider('desktop.test.echo'), provider);

  const result = await registry.execute(request, context);
  assert.equal(result.request, request);
  assert.equal(result.context, context);
  assert.equal(result.capabilityId, 'desktop.test.echo');
  assert.deepEqual(result.outputPreview, { message: 'hello' });
});

test('desktop registry keeps prefix routing but only lists explicit capability ids', async () => {
  const provider = createDesktopProvider({
    providerId: 'desktop.prefix',
    capabilityIds: undefined,
    capabilityPrefix: 'desktop.prefix.',
  });
  const registry = createCapabilityProviderRegistry({ providers: [provider] });

  assert.equal(registry.hasCapability('desktop.prefix.dynamic'), false);
  assert.deepEqual(registry.listCapabilityIds(), []);
  assert.equal(registry.getProvider('desktop.prefix.dynamic'), provider);

  const result = await registry.execute(createRequest('desktop.prefix.dynamic'), {});
  assert.equal(result.capabilityId, 'desktop.prefix.dynamic');
});

test('desktop registry returns null for unsupported requests', async () => {
  const registry = createCapabilityProviderRegistry({ providers: [createDesktopProvider()] });

  assert.equal(registry.getProvider('desktop.unknown'), null);
  assert.equal(await registry.execute(createRequest('desktop.unknown'), {}), null);
  assert.equal(await registry.execute({ call: {} }, {}), null);
});

test('desktop registry surfaces runtime-core duplicate errors', () => {
  assert.throws(
    () => createCapabilityProviderRegistry({ providers: [createDesktopProvider(), createDesktopProvider()] }),
    (error) => error instanceof CapabilityRegistryError && error.code === 'duplicate_provider',
  );

  assert.throws(
    () =>
      createCapabilityProviderRegistry({
        providers: [
          createDesktopProvider({ providerId: 'desktop.a' }),
          createDesktopProvider({ providerId: 'desktop.b' }),
        ],
      }),
    (error) => error instanceof CapabilityRegistryError && error.code === 'duplicate_capability',
  );
});
