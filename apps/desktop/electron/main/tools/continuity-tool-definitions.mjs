import { CONTINUITY_TOOL_SPECS, WORKING_CONTEXT_DESCRIPTION } from '@peer-agent/runtime-node/project-agent';

export const CONTINUITY_TOOL_DEFINITIONS = CONTINUITY_TOOL_SPECS.map(spec => ({
  name: spec.name, capabilityId: spec.capabilityId, inputSchema: spec.inputSchema,
  availableInModes: ['project_agent', 'goal'], prompt: () => WORKING_CONTEXT_DESCRIPTION,
  runtime: { adapter: 'runtime-gateway.local-continuity-provider', executorCapabilityId: spec.capabilityId },
  permissionPolicy: { kind: ['write_work_note', 'prepare_context_handoff'].includes(spec.name) ? 'goal-create' : 'goal-read' },
}));
