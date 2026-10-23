import type { CapabilityManifest, CapabilityProvider, RuntimeToolStatus } from '@peer-agent/runtime-core';
import type { RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';
import { LOCAL_GIT_CAPABILITY } from '@peer-agent/protocol';
import { createLocalGitProvider } from './local-git-provider.mjs';
import { LOCAL_GIT_MODES, LOCAL_GIT_SCHEMA, LOCAL_GIT_TOOL_DEFINITIONS } from './local-git-tools.mjs';
import { createNodePermissionGrant, createNodeToolResult, createProviderRuntimeClock } from './provider-utils.ts';
import type { CreateNodeProviderBundleOptions } from './provider-contracts.ts';

export const NODE_GIT_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = [{
  capabilityId: LOCAL_GIT_CAPABILITY, displayName: 'Read Git repository',
  description: LOCAL_GIT_TOOL_DEFINITIONS[0]!.prompt(), sideEffectLevel: 'L1',
  modeScopes: LOCAL_GIT_MODES, inputSchema: LOCAL_GIT_SCHEMA,
}];

export function createNodeGitProvider(options: CreateNodeProviderBundleOptions): CapabilityProvider {
  const clock = createProviderRuntimeClock(options);
  const provider = createLocalGitProvider({ workspaceRoot: options.workspaceRoot, artifactBaseDir: options.git ? options.git.artifactRoot : undefined });
  return { providerId: 'runtime-node.git', capabilities: NODE_GIT_CAPABILITY_MANIFESTS,
    async execute(request, context) {
      const source = request.toolCall as RuntimeSdkToolCall;
      const call = { ...source, capabilityId: LOCAL_GIT_CAPABILITY, arguments: request.input ?? source.input };
      const execution = await provider.executeCapability({ call }, { signal: context.signal,
        toolContext: { workspacePath: options.workspaceRoot, conversationId: context.metadata?.conversationId,
          permissionPolicy: context.metadata?.permissionPolicy,
          checkAccessPolicy: () => options.executionGate?.(call) },
        requestPermission: options.requestPermission ? input => options.requestPermission!({
          ...input, workspacePath: options.workspaceRoot,
          confirmation: { kind: 'capability-approval', approvalKind: 'file-read', reason: 'git_read_outside_roots' },
          scope: { kind: 'capability-approval', capabilityId: LOCAL_GIT_CAPABILITY, workspaceRoot: options.workspaceRoot },
          metadata: { path: input.filePath, operation: 'git_read' },
        }) : undefined,
      });
      const result = execution!.result;
      const preview: Record<string, unknown> = result.outputPreview;
      const reason = typeof preview.reason === 'string' ? preview.reason : undefined;
      const status: RuntimeToolStatus = result.status === 'success' ? 'completed'
        : result.status === 'denied' ? 'denied' : result.status === 'cancelled' ? 'cancelled' : result.status === 'timeout' ? 'timeout' : 'failed';
      const grant = createNodePermissionGrant({ clock, call: source, decision: execution!.grant.granted ? 'allow' : 'deny', reason });
      return createNodeToolResult({ clock, call: source, status,
        summary: result.evidence.summary, outputPreview: preview, grant, dataLevel: 'D2_sensitive',
        artifactRefs: result.evidence.artifactRefs,
        ...(result.status === 'success' ? {} : { error: { code: reason || 'git_query_failed', message: reason || 'git_query_failed',
          recoverable: (preview.diagnostic as { retryable?: boolean } | undefined)?.retryable === true } }),
      });
    } };
}
