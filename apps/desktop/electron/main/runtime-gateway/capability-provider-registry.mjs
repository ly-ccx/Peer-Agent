function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Capability provider must be an object.');
  }
  if (!provider.providerId) {
    throw new Error('Capability provider must declare providerId.');
  }
  const hasIds = Array.isArray(provider.capabilityIds) && provider.capabilityIds.length > 0;
  const hasPrefix = typeof provider.capabilityPrefix === 'string' && provider.capabilityPrefix.length > 0;
  if (!hasIds && !hasPrefix) {
    throw new Error(`Capability provider ${provider.providerId} must declare capabilityIds or capabilityPrefix.`);
  }
  if (typeof provider.executeCapability !== 'function') {
    throw new Error(`Capability provider ${provider.providerId} must implement executeCapability.`);
  }
}

export function createCapabilityProviderRegistry({ providers = [] } = {}) {
  const providerByCapabilityId = new Map();
  const prefixProviders = [];
  const providersById = new Map();

  function register(provider) {
    assertProvider(provider);
    if (providersById.has(provider.providerId)) {
      throw new Error(`Duplicate capability provider: ${provider.providerId}`);
    }
    for (const capabilityId of (provider.capabilityIds ?? [])) {
      if (providerByCapabilityId.has(capabilityId)) {
        throw new Error(`Duplicate capability provider for capability: ${capabilityId}`);
      }
    }
    providersById.set(provider.providerId, provider);
    for (const capabilityId of (provider.capabilityIds ?? [])) {
      providerByCapabilityId.set(capabilityId, provider);
    }
    if (provider.capabilityPrefix) {
      prefixProviders.push(provider);
    }
    return provider;
  }

  function getProvider(capabilityId) {
    const exact = providerByCapabilityId.get(capabilityId);
    if (exact) return exact;
    for (const provider of prefixProviders) {
      if (capabilityId.startsWith(provider.capabilityPrefix)) return provider;
    }
    return null;
  }

  async function execute(request, context = {}) {
    const provider = getProvider(request.call?.capabilityId);
    if (!provider) return null;
    return provider.executeCapability(request, context);
  }

  providers.forEach(register);

  return {
    register,
    getProvider,
    execute,
    hasCapability: (capabilityId) => providerByCapabilityId.has(capabilityId),
    listCapabilityIds: () => [...providerByCapabilityId.keys()],
    listProviderIds: () => [...providersById.keys()],
  };
}
