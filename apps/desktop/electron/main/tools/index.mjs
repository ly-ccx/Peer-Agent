import { AUTOMATION_TOOL_DEFINITIONS } from './automation-tool-definitions.mjs';
import { GOAL_TOOL_DEFINITIONS } from './goal-tool-definitions.mjs';
import { INTERACTION_TOOL_DEFINITIONS } from './interaction-tool-definitions.mjs';
import { LEGACY_LOCAL_TOOL_DEFINITIONS } from './legacy-local-tool-definitions.mjs';
import { createMcpToolDefinitionsFromRegistry } from './mcp-tool-definitions.mjs';
import { SEARCH_TOOL_DEFINITIONS } from './search-tool-definitions.mjs';
import { WEB_TOOL_DEFINITIONS } from './web-tool-definitions.mjs';
import { BROWSER_TOOL_DEFINITIONS } from './browser-tool-definitions.mjs';
import {
  buildAnthropicToolsFromModelProjection,
  buildAnthropicToolsFromRegistry,
  buildOpenAIToolsFromModelProjection,
  buildOpenAIToolsFromRegistry,
  createModelToolProjectionFromRegistry,
} from './provider-tool-materializer.mjs';
import {
  buildAnthropicToolsFromRuntimeProjection,
  buildOpenAIToolsFromRuntimeProjection,
  createModelToolProjectionFromRuntimeProjection,
  createRuntimeProjectionFromToolRegistry,
} from './runtime-projection-tool-materializer.mjs';
import { createToolRegistry } from './tool-registry.mjs';

export { TOOL_NAMES } from './legacy-local-tool-definitions.mjs';
export { createToolRegistry } from './tool-registry.mjs';
export {
  buildAnthropicToolsFromModelProjection,
  buildAnthropicToolsFromRegistry,
  buildOpenAIToolsFromModelProjection,
  buildOpenAIToolsFromRegistry,
  createModelToolProjectionFromRegistry,
  createRuntimeToolDefinition,
  createRuntimeToolDefinitionsFromRegistry,
} from './provider-tool-materializer.mjs';
export {
  buildAnthropicToolsFromRuntimeProjection,
  buildOpenAIToolsFromRuntimeProjection,
  createModelToolProjectionFromRuntimeProjection,
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
      ...SEARCH_TOOL_DEFINITIONS,
      ...GOAL_TOOL_DEFINITIONS,
      ...INTERACTION_TOOL_DEFINITIONS,
      ...AUTOMATION_TOOL_DEFINITIONS,
      ...WEB_TOOL_DEFINITIONS,
      ...BROWSER_TOOL_DEFINITIONS,
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
  const modelProjection = createModelToolProjectionFromRuntimeProjection(
    projection,
    registry,
    { mode: projectionOptions.mode },
  );
  return { registry, projection, modelProjection };
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
  return buildOpenAIToolsFromModelProjection(createModelToolProjectionFromRegistry(registry));
}

export function buildAnthropicTools(registry = DEFAULT_TOOL_REGISTRY) {
  return buildAnthropicToolsFromModelProjection(createModelToolProjectionFromRegistry(registry));
}
