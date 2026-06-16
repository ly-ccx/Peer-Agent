import { LEGACY_LOCAL_TOOL_DEFINITIONS } from './legacy-local-tool-definitions.mjs';
import { createMcpToolDefinitionsFromRegistry } from './mcp-tool-definitions.mjs';
import {
  buildAnthropicToolsFromRegistry,
  buildOpenAIToolsFromRegistry,
} from './provider-tool-materializer.mjs';
import {
  buildAnthropicToolsFromRuntimeProjection,
  buildOpenAIToolsFromRuntimeProjection,
  createRuntimeProjectionFromToolRegistry,
} from './runtime-projection-tool-materializer.mjs';
import { createToolRegistry } from './tool-registry.mjs';

export { TOOL_NAMES } from './legacy-local-tool-definitions.mjs';
export { createToolRegistry } from './tool-registry.mjs';
export {
  buildAnthropicToolsFromRegistry,
  buildOpenAIToolsFromRegistry,
} from './provider-tool-materializer.mjs';
export {
  buildAnthropicToolsFromRuntimeProjection,
  buildOpenAIToolsFromRuntimeProjection,
  createProjectedToolRegistry,
  createRuntimeProjectionFromToolRegistry,
} from './runtime-projection-tool-materializer.mjs';

export function createDefaultToolRegistry() {
  return createToolRegistry({
    tools: LEGACY_LOCAL_TOOL_DEFINITIONS,
  });
}

export function createRuntimeToolRegistry({ mcpRegistry } = {}) {
  return createToolRegistry({
    tools: [
      ...LEGACY_LOCAL_TOOL_DEFINITIONS,
      ...createMcpToolDefinitionsFromRegistry(mcpRegistry),
    ],
  });
}

export function createRuntimeToolProjection({
  mcpRegistry,
  registry = createRuntimeToolRegistry({ mcpRegistry }),
  projectionOptions = {},
} = {}) {
  const projection = createRuntimeProjectionFromToolRegistry(registry, projectionOptions);
  return { registry, projection };
}

export const DEFAULT_TOOL_REGISTRY = createDefaultToolRegistry();
export const DEFAULT_RUNTIME_PROJECTION = createRuntimeProjectionFromToolRegistry(DEFAULT_TOOL_REGISTRY);
export const TOOL_REGISTRY = DEFAULT_TOOL_REGISTRY.listTools();

export function listToolDefinitions() {
  return DEFAULT_TOOL_REGISTRY.listTools();
}

export function getToolDefinition(name) {
  return DEFAULT_TOOL_REGISTRY.getTool(name);
}

export function buildOpenAITools(registry = DEFAULT_TOOL_REGISTRY) {
  const projection = createRuntimeProjectionFromToolRegistry(registry);
  return buildOpenAIToolsFromRuntimeProjection(projection, registry);
}

export function buildAnthropicTools(registry = DEFAULT_TOOL_REGISTRY) {
  const projection = createRuntimeProjectionFromToolRegistry(registry);
  return buildAnthropicToolsFromRuntimeProjection(projection, registry);
}
