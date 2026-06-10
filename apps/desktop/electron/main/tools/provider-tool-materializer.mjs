export function buildOpenAIToolsFromRegistry(registry) {
  return registry.listTools().map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.prompt(),
      parameters: tool.inputSchema,
    },
  }));
}

export function buildAnthropicToolsFromRegistry(registry) {
  return registry.listTools().map((tool) => ({
    name: tool.name,
    description: tool.prompt(),
    input_schema: tool.inputSchema,
  }));
}
