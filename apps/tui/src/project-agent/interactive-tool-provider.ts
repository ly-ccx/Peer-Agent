import type { CapabilityManifest, RuntimeToolDefinition } from '@peer-agent/runtime-core';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';
import { INTERACTIVE_TOOL_DEFINITIONS, createInteractiveRuntime } from '@peer-agent/runtime-node/interactive-results';
import type { TuiCapabilityProvider } from '../tui-host.ts';

/** Adapt the shared Provider to Node's risk, approval and result interfaces. */
export function createInteractiveToolProvider(runtime: ReturnType<typeof createInteractiveRuntime>): TuiCapabilityProvider {
  const manifests: CapabilityManifest[] = INTERACTIVE_TOOL_DEFINITIONS.map(tool => ({
    capabilityId: tool.capabilityId, displayName: tool.name, description: tool.manifest.description,
    inputSchema: tool.inputSchema, modeScopes: tool.availableInModes,
    riskLevel: tool.capabilityId === 'local.interactive.publish' ? 'L2_low_write' : 'L1_readonly',
  }));
  const toolDefinitions: RuntimeToolDefinition[] = manifests.map(manifest => ({
    name: manifest.displayName, capabilityId: manifest.capabilityId, description: manifest.description,
    inputSchema: manifest.inputSchema, modeScopes: manifest.modeScopes, metadata: { riskLevel: manifest.riskLevel },
  }));
  return { manifests, toolDefinitions,
    async execute(capabilityId, args, context) {
      if (!context.toolCallId) throw new Error('interactive_call_invalid');
      const call = { toolCallId: context.toolCallId, capabilityId, arguments: args };
      const execution = await runtime.provider.executeCapability({ call }, {
        signal: context.signal, toolContext: context.toolContext,
        requestPermission: async (request: any) => context.requestPermission?.({ ...request,
          workspacePath: String(context.toolContext?.workspacePath ?? ''), reason: request.confirmation.reason, riskLevel: 'L2_low_write' }),
      });
      if (!execution) throw new Error('capability_not_projected');
      return { ...execution, result: { ...execution.result, capabilityId,
        status: execution.result.status === 'success' ? 'completed' : execution.result.status,
        output: execution.result.outputPreview } } as RuntimeSdkProviderExecution;
    },
  };
}
