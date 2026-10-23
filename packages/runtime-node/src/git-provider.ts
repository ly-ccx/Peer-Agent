import type { CapabilityManifest, CapabilityProvider, RuntimeToolStatus } from '@peer-agent/runtime-core';
import type { RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';
import { LOCAL_GIT_CAPABILITY, LOCAL_GIT_TOOL } from '@peer-agent/protocol';
import { createLocalGitProvider } from './local-git-provider.mjs';
import { LOCAL_GIT_MODES, LOCAL_GIT_SCHEMA, LOCAL_GIT_TOOL_DEFINITIONS } from './local-git-tools.mjs';
import { createNodePermissionGrant, createNodeToolResult, createProviderRuntimeClock } from './provider-utils.ts';
import type { CreateNodeProviderBundleOptions } from './provider-contracts.ts';

export const NODE_GIT_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = [{
  capabilityId: LOCAL_GIT_CAPABILITY, displayName: 'Read Git repository',
  description: LOCAL_GIT_TOOL_DEFINITIONS[0]!.prompt(), riskLevel: 'L1_readonly',
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
        requestPermission: options.requestPermission ? (input: { readonly filePath?: string; readonly [key: string]: unknown }) => options.requestPermission!({
          ...input,
          tool: LOCAL_GIT_TOOL,
          toolName: LOCAL_GIT_TOOL,
          capabilityId: LOCAL_GIT_CAPABILITY,
          args: input,
          workspacePath: options.workspaceRoot,
          reason: 'git_read_outside_roots',
          confirmation: { kind: 'capability-approval', approvalKind: 'file-read', reason: 'git_read_outside_roots' },
          scope: { kind: 'capability-approval', capabilityId: LOCAL_GIT_CAPABILITY, workspaceRoot: options.workspaceRoot },
          riskLevel: 'L1_readonly',
          dataLevel: 'D2_sensitive',
          metadata: { path: input.filePath, operation: 'git_read' },
        }) : undefined,
      });
      const result = execution!.result;
      // .mjs 写入的是对象，但声明为 unknown；按实际形状收窄，缺失时退化成空对象。
      const rawPreview = result.outputPreview;
      const preview: Record<string, unknown> =
        typeof rawPreview === 'object' && rawPreview !== null && !Array.isArray(rawPreview)
          ? rawPreview as Record<string, unknown>
          : {};
      const reason = typeof preview.reason === 'string' ? preview.reason : undefined;
      const status: RuntimeToolStatus = result.status === 'success' ? 'completed'
        : result.status === 'denied' ? 'denied' : result.status === 'cancelled' ? 'cancelled' : result.status === 'timeout' ? 'timeout' : 'failed';
      const grant = createNodePermissionGrant({ clock, call: source, decision: execution!.grant.granted ? 'allow' : 'deny', reason });
      // RuntimeEvidenceObject 是 Readonly<Record<string, unknown>>，字段本身没有
      // 静态类型；这里按 .mjs 实际写入的形状收窄，而不是把 unknown 直接塞给
      // createNodeToolResult 的 string / string[] 参数。
      const evidence = (result.evidence ?? {}) as { readonly summary?: unknown; readonly artifactRefs?: unknown };
      const summary = typeof evidence.summary === 'string' ? evidence.summary : '';
      const artifactRefs = Array.isArray(evidence.artifactRefs)
        ? evidence.artifactRefs.filter((ref): ref is string => typeof ref === 'string')
        : undefined;
      return createNodeToolResult({ clock, call: source, status,
        summary, outputPreview: preview, grant, dataLevel: 'D2_sensitive',
        artifactRefs,
        ...(result.status === 'success' ? {} : { error: { code: reason || 'git_query_failed', message: reason || 'git_query_failed',
          recoverable: (preview.diagnostic as { retryable?: boolean } | undefined)?.retryable === true } }),
      });
    } };
}
