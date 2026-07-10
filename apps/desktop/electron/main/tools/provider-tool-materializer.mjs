import {
  createRuntimeProjection,
  materializeAnthropicTools,
  materializeOpenAITools,
} from '@peer-agent/runtime-core';

export function createRuntimeToolDefinition(tool) {
  return {
    name: tool.name,
    capabilityId: tool.runtime?.executorCapabilityId || tool.capabilityId,
    description: tool.prompt(),
    inputSchema: tool.inputSchema,
    ...(Array.isArray(tool.availableInModes)
      ? { modeScopes: tool.availableInModes }
      : {}),
  };
}

export function createRuntimeToolDefinitionsFromRegistry(registry) {
  return registry.listTools().map(createRuntimeToolDefinition);
}

export function createModelToolProjectionFromRegistry(registry, options = {}) {
  return createRuntimeProjection(
    createRuntimeToolDefinitionsFromRegistry(registry),
    options,
  );
}

export function buildOpenAIToolsFromModelProjection(projection) {
  return materializeOpenAITools(projection);
}

export function buildAnthropicToolsFromModelProjection(projection) {
  return materializeAnthropicTools(projection);
}

export function buildOpenAIToolsFromRegistry(registry) {
  return buildOpenAIToolsFromModelProjection(createModelToolProjectionFromRegistry(registry));
}

export function buildAnthropicToolsFromRegistry(registry) {
  return buildAnthropicToolsFromModelProjection(createModelToolProjectionFromRegistry(registry));
}
