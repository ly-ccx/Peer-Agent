import { MEMORY_TOOL_SPECS, projectToolDescription } from '@peer-agent/runtime-node';

const MEMORY_RUNTIME = Object.freeze({
  adapter: 'runtime-gateway.local-memory-provider',
});

const READ_TOOLS = new Set(['memory_search']);

export const MEMORY_TOOL_DEFINITIONS = MEMORY_TOOL_SPECS.map((item) => ({
  name: item.name,
  capabilityId: item.capabilityId,
  availableInModes: ['project_agent'],
  prompt: () => projectToolDescription(item.name),
  runtime: Object.freeze({
    ...MEMORY_RUNTIME,
    executorCapabilityId: item.capabilityId,
  }),
  permissionPolicy: {
    kind: READ_TOOLS.has(item.name) ? 'goal-read' : 'goal-create',
  },
  inputSchema: item.inputSchema,
}));
