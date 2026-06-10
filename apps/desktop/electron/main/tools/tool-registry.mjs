function assertToolDefinition(tool) {
  if (!tool || typeof tool !== 'object') {
    throw new Error('Tool definition must be an object.');
  }
  if (!tool.name || typeof tool.name !== 'string') {
    throw new Error('Tool definition must declare name.');
  }
  if (typeof tool.prompt !== 'function') {
    throw new Error(`Tool definition ${tool.name} must implement prompt().`);
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
    throw new Error(`Tool definition ${tool.name} must declare inputSchema.`);
  }
}

export function createToolRegistry({ tools = [] } = {}) {
  const toolByName = new Map();

  function register(tool) {
    assertToolDefinition(tool);
    if (toolByName.has(tool.name)) {
      throw new Error(`Duplicate tool definition: ${tool.name}`);
    }
    toolByName.set(tool.name, Object.freeze({ ...tool }));
    return toolByName.get(tool.name);
  }

  tools.forEach(register);

  return {
    register,
    getTool: (name) => toolByName.get(name) ?? null,
    listTools: () => [...toolByName.values()],
    listToolNames: () => [...toolByName.keys()],
  };
}
