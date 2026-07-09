import type {
  CapabilityExecutionContext,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityResult,
  RuntimeCapabilityId,
  RuntimeProviderId,
} from './contracts.ts';

export type CapabilityRegistryErrorCode =
  | 'invalid_provider'
  | 'duplicate_provider'
  | 'duplicate_capability'
  | 'capability_not_found';

export class CapabilityRegistryError extends Error {
  readonly code: CapabilityRegistryErrorCode;

  constructor(message: string, code: CapabilityRegistryErrorCode) {
    super(message);
    this.name = 'CapabilityRegistryError';
    this.code = code;
  }
}

function providerCapabilityIds(provider: CapabilityProvider): readonly RuntimeCapabilityId[] {
  if (Array.isArray(provider.capabilityIds)) {
    return provider.capabilityIds;
  }
  if (Array.isArray(provider.capabilities)) {
    return provider.capabilities.map((capability) => capability.capabilityId);
  }
  return [];
}

function assertProvider(provider: CapabilityProvider): void {
  if (!provider || typeof provider !== 'object') {
    throw new CapabilityRegistryError('Capability provider must be an object.', 'invalid_provider');
  }
  if (!provider.providerId) {
    throw new CapabilityRegistryError('Capability provider must declare providerId.', 'invalid_provider');
  }
  const hasIds = providerCapabilityIds(provider).length > 0;
  const hasPrefix = typeof provider.capabilityPrefix === 'string' && provider.capabilityPrefix.length > 0;
  const hasCanHandle = typeof provider.canHandle === 'function';
  if (!hasIds && !hasPrefix && !hasCanHandle) {
    throw new CapabilityRegistryError(
      'Capability provider must declare capabilityIds, capabilities, capabilityPrefix, or canHandle().',
      'invalid_provider',
    );
  }
  if (typeof provider.execute !== 'function') {
    throw new CapabilityRegistryError('Capability provider must implement execute().', 'invalid_provider');
  }
}

export interface CapabilityProviderRegistry {
  register(provider: CapabilityProvider): void;
  getProvider(capabilityId: RuntimeCapabilityId): CapabilityProvider | undefined;
  execute(request: CapabilityRequest, context: CapabilityExecutionContext): Promise<CapabilityResult>;
  hasCapability(capabilityId: RuntimeCapabilityId): boolean;
  listCapabilityIds(): RuntimeCapabilityId[];
  listProviderIds(): RuntimeProviderId[];
}

export function createCapabilityProviderRegistry(
  initialProviders: readonly CapabilityProvider[] = [],
): CapabilityProviderRegistry {
  const providersById = new Map<RuntimeProviderId, CapabilityProvider>();
  const providerByCapabilityId = new Map<RuntimeCapabilityId, CapabilityProvider>();
  const prefixProviders: CapabilityProvider[] = [];
  const customProviders: CapabilityProvider[] = [];

  function register(provider: CapabilityProvider): void {
    assertProvider(provider);
    if (providersById.has(provider.providerId)) {
      throw new CapabilityRegistryError(
        `Duplicate capability provider: ${provider.providerId}`,
        'duplicate_provider',
      );
    }
    providersById.set(provider.providerId, provider);

    for (const capabilityId of providerCapabilityIds(provider)) {
      if (providerByCapabilityId.has(capabilityId)) {
        throw new CapabilityRegistryError(
          `Duplicate capability id: ${capabilityId}`,
          'duplicate_capability',
        );
      }
      providerByCapabilityId.set(capabilityId, provider);
    }

    if (provider.capabilityPrefix) {
      prefixProviders.push(provider);
    }
    if (provider.canHandle) {
      customProviders.push(provider);
    }
  }

  function getProvider(capabilityId: RuntimeCapabilityId): CapabilityProvider | undefined {
    const direct = providerByCapabilityId.get(capabilityId);
    if (direct) {
      return direct;
    }
    const prefixed = prefixProviders.find((provider) => capabilityId.startsWith(provider.capabilityPrefix ?? ''));
    if (prefixed) {
      return prefixed;
    }
    return customProviders.find((provider) => provider.canHandle?.(capabilityId));
  }

  async function execute(
    request: CapabilityRequest,
    context: CapabilityExecutionContext,
  ): Promise<CapabilityResult> {
    const provider = getProvider(request.capabilityId);
    if (!provider) {
      throw new CapabilityRegistryError(
        `No capability provider found for ${request.capabilityId}`,
        'capability_not_found',
      );
    }
    return provider.execute(request, context);
  }

  for (const provider of initialProviders) {
    register(provider);
  }

  return {
    register,
    getProvider,
    execute,
    hasCapability: (capabilityId) => Boolean(getProvider(capabilityId)),
    listCapabilityIds: () => [...providerByCapabilityId.keys()],
    listProviderIds: () => [...providersById.keys()],
  };
}
