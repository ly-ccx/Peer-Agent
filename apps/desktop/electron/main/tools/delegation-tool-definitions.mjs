import { DELEGATION_TOOL_SPECS, projectToolDescription } from '@peer-agent/runtime-node';

const DELEGATION_RUNTIME = Object.freeze({
  adapter: 'runtime-gateway.local-delegation-provider',
});

export const DELEGATION_TOOL_DEFINITIONS = DELEGATION_TOOL_SPECS.map((item) => ({
  name: item.name,
  capabilityId: item.capabilityId,
  availableInModes: ['project_agent'],
  prompt: () => projectToolDescription(item.name),
  runtime: Object.freeze({
    ...DELEGATION_RUNTIME,
    executorCapabilityId: item.capabilityId,
  }),
  permissionPolicy: {
    kind: item.name === 'list_sessions' || item.name === 'get_session' || item.name === 'get_verification_detail' || item.name === 'list_objectives' || item.name === 'get_objective'
      ? 'goal-read'
      : 'goal-create',
  },
  inputSchema: item.inputSchema,
}));
