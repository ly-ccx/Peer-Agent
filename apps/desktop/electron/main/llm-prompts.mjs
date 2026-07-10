import {
  assembleSystemContext,
  renderRuntimeContext,
  renderSystemContext,
  renderSystemCorePrompt,
} from './prompt/index.mjs';
export {
  buildAnthropicTools,
  buildAnthropicToolsFromModelProjection,
  buildAnthropicToolsFromRegistry,
  buildAnthropicToolsFromRuntimeProjection,
  buildOpenAITools,
  buildOpenAIToolsFromModelProjection,
  buildOpenAIToolsFromRegistry,
  buildOpenAIToolsFromRuntimeProjection,
  createDefaultToolRegistry,
  createRuntimeToolProjection,
  createRuntimeToolRegistry,
  createToolRegistry,
  getToolDefinition,
  listToolDefinitions,
  TOOL_NAMES,
  TOOL_REGISTRY,
} from './tools/index.mjs';

export function buildRuntimeContext(workspacePath) {
  return renderRuntimeContext(workspacePath);
}

export function buildSystemCorePrompt() {
  return renderSystemCorePrompt();
}

export function buildSystemContext(workspacePath, options = {}) {
  return assembleSystemContext({
    workspacePath,
    ...options,
  });
}

export function buildSystemPrompt(workspacePath, options = {}) {
  return renderSystemContext(buildSystemContext(workspacePath, options));
}

export { renderSystemContext };
