import {
  CapabilityRegistryError,
  createCapabilityProviderRegistry as createCoreCapabilityProviderRegistry,
} from '@peer-agent/runtime-core';

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
    throw new Error('Capability provider must declare capabilityIds or capabilityPrefix.');
  }
  if (typeof provider.executeCapability !== 'function') {
    throw new Error('Capability provider must implement executeCapability.');
  }
}

function getRequestCapabilityId(request) {
  return request?.call?.capabilityId;
}

function getRequestToolCallId(request, capabilityId) {
  return request?.call?.id ?? request?.call?.toolCallId ?? capabilityId;
}

function getRequestInput(request) {
  return request?.call?.arguments ?? request?.input;
}

function getRequestMetadata(request) {
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  const { call, ...metadata } = request;
  return metadata;
}

function toCoreRequest(request, capabilityId) {
  return {
    capabilityId,
    input: getRequestInput(request),
    toolCall: {
      toolCallId: getRequestToolCallId(request, capabilityId),
      capabilityId,
      input: getRequestInput(request),
      metadata: getRequestMetadata(request),
    },
    metadata: {
      ...getRequestMetadata(request),
      desktopRequest: request,
    },
  };
}

function toCoreProvider(provider) {
  return {
    providerId: provider.providerId,
    capabilityIds: provider.capabilityIds,
    capabilityPrefix: provider.capabilityPrefix,
    execute: (request, context) => {
      const desktopRequest = request?.metadata?.desktopRequest ?? request;
      return provider.executeCapability(desktopRequest, context);
    },
  };
}

function isCapabilityNotFound(error) {
  return error instanceof CapabilityRegistryError && error.code === 'capability_not_found';
}

export function createCapabilityProviderRegistry({ providers = [] } = {}) {
  const coreRegistry = createCoreCapabilityProviderRegistry();
  const providersById = new Map();
  const explicitCapabilityIds = new Set();

  function register(provider) {
    assertProvider(provider);
    coreRegistry.register(toCoreProvider(provider));
    providersById.set(provider.providerId, provider);
    for (const capabilityId of provider.capabilityIds ?? []) {
      explicitCapabilityIds.add(capabilityId);
    }
  }

  function unregister(providerId) {
    const existing = providersById.get(providerId);
    if (!existing) return false;
    coreRegistry.unregister(providerId);
    providersById.delete(providerId);
    for (const capabilityId of existing.capabilityIds ?? []) {
      explicitCapabilityIds.delete(capabilityId);
    }
    return true;
  }

  function replace(provider) {
    if (providersById.has(provider.providerId)) unregister(provider.providerId);
    register(provider);
  }

  function getProvider(capabilityId) {
    const coreProvider = coreRegistry.getProvider(capabilityId);
    if (!coreProvider) {
      return null;
    }
    return providersById.get(coreProvider.providerId) ?? null;
  }

  async function execute(request, context) {
    const capabilityId = getRequestCapabilityId(request);
    if (!capabilityId) {
      return null;
    }
    try {
      return await coreRegistry.execute(toCoreRequest(request, capabilityId), context);
    } catch (error) {
      if (isCapabilityNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  providers.forEach(register);

  return {
    register,
    unregister,
    replace,
    getProvider,
    execute,
    hasCapability: (capabilityId) => explicitCapabilityIds.has(capabilityId),
    listCapabilityIds: () => [...explicitCapabilityIds],
    listProviderIds: () => [...providersById.keys()],
  };
}
