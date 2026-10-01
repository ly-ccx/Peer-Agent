import { createRuntimeProjection, type CapabilityManifest, type RuntimeToolDefinition } from '@peer-agent/runtime-core';
import { createRuntimeSdk, type RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';
import {
  DELEGATION_TOOL_SPECS, MEMORY_TOOL_SPECS, projectToolDescription, createDelegationProvider,
  createMemoryProvider, createPermissionGrant, createFailedClientToolResult,
} from '@peer-agent/runtime-node';
import type { TuiCapabilityProvider, TuiExecutionContext } from '../tui-host.ts';

/** Shared specs supply an explicit manifest and mode projection before dispatch. */
export function createProjectToolProvider(options: {
  rootDir: string;
  supervisor: object;
  objectives: object;
  replyComposer: object;
  verification: object;
  proactivity: object;
  checkModel: (input: object) => object;
  memoryEnabled: (workspaceId: string) => boolean;
}): TuiCapabilityProvider & { dispose(): void } {
  const delegation = createDelegationProvider({ ...options, storeDir: `${options.rootDir}/project-runtime` } as never);
  const memory = createMemoryProvider({ rootDir: options.rootDir, enabled: options.memoryEnabled });
  const specs = [...DELEGATION_TOOL_SPECS, ...MEMORY_TOOL_SPECS];
  const manifests: CapabilityManifest[] = specs.map(spec => ({
    displayName: spec.name, capabilityId: spec.capabilityId,
    description: projectToolDescription(spec.name),
    inputSchema: spec.inputSchema, modeScopes: ['project_agent'],
  }));
  const toolDefinitions: RuntimeToolDefinition[] = manifests.map(manifest => ({
    name: manifest.displayName, capabilityId: manifest.capabilityId,
    description: manifest.description!, inputSchema: manifest.inputSchema, modeScopes: manifest.modeScopes,
  }));
  const projection = createRuntimeProjection(toolDefinitions, { mode: 'project_agent' });
  const routes = new Map(specs.map(spec => [spec.capabilityId,
    MEMORY_TOOL_SPECS.includes(spec) ? memory : delegation]));
  const runtime = createRuntimeSdk({ host: {
    executeProvider: (request, context) => {
      const provider = routes.get(request.call.capabilityId);
      if (!provider || context.mode !== 'project_agent' || !projection.tools.some(tool => tool.capabilityId === request.call.capabilityId)) return Promise.resolve({
        call: request.call,
        result: createFailedClientToolResult({ call: request.call, locale: 'zh-CN', reason: 'capability_not_projected' }),
      }) as Promise<RuntimeSdkProviderExecution>;
      return provider.executeCapability(request, context) as Promise<RuntimeSdkProviderExecution>;
    },
    createBlockedExecution: ({ request, reason }) => ({
      call: request.call,
      grant: createPermissionGrant({ toolCallId: request.call.toolCallId, granted: false, scope: request.call.capabilityId }),
      result: createFailedClientToolResult({ call: request.call, locale: 'zh-CN', reason }),
    }),
  } });
  return {
    manifests,
    toolDefinitions,
    async execute(capabilityId, arguments_, context: TuiExecutionContext) {
      return runtime.execute({ sessionId: context.sessionId,
        conversationId: context.conversationId, projectionId: projection.createdAt,
        call: { toolCallId: context.toolCallId ?? 'project-tool', capabilityId, arguments: arguments_ },
      }, { ...context, ...(context.toolContext ?? {}) });
    },
    dispose: () => memory.close(),
  };
}
