function normalizeInputSchema(schema) {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) return schema;
  return { type: 'object', additionalProperties: true };
}

function createMcpToolDefinition(manifest) {
  return {
    name: manifest.name,
    capabilityId: manifest.capabilityId,
    prompt: () => manifest.description || manifest.displayName || manifest.name,
    inputSchema: normalizeInputSchema(manifest.inputSchema),
    runtime: {
      executor: 'local-tool-host',
      executorCapabilityId: manifest.runtime?.executorCapabilityId ?? manifest.capabilityId,
    },
    permissionPolicy: manifest.permissionPolicy ?? {
      kind: 'mcp-tool',
      required: true,
    },
    source: 'mcp',
    manifest,
  };
}

export function createMcpToolDefinitionsFromRegistry(mcpRegistry) {
  if (!mcpRegistry || typeof mcpRegistry.listCapabilityManifests !== 'function') return [];
  return mcpRegistry.listCapabilityManifests().map(createMcpToolDefinition);
}
