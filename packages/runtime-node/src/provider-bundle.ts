import { resolve } from 'node:path';

import {
  SHARED_LOCAL_TOOL_CONTRACT_LIST,
  createCapabilityProviderRegistry,
  createRuntimeProjection,
  type CapabilityExecutionContext,
  type CapabilityManifest,
  type RuntimeToolDefinition,
} from '@peer-agent/runtime-core';
import {
  createRuntimeSdk,
  type RuntimePipelineToolCall,
  type RuntimePipelineToolExecutor,
  type RuntimeSdkExecuteRequest,
  type RuntimeSdkProviderExecution,
} from '@peer-agent/runtime-sdk';

import { createNodeFileProvider, NODE_FILE_CAPABILITY_MANIFESTS } from './file-provider.ts';
import { createNodeRuntimeHostAdapter } from './host-adapter.ts';
import type {
  CreateNodeProviderBundleOptions,
  NodeProviderBundle,
} from './provider-contracts.ts';
import {
  appendNodeHookEvidence,
  createNodeResultFactory,
  createNodeToolResult,
  createProviderRuntimeClock,
} from './provider-utils.ts';
import {
  createNodeSearchAggregateProvider,
  NODE_SEARCH_AGGREGATE_CAPABILITY_MANIFESTS,
} from './search-aggregate-provider.ts';
import { createNodeShellProvider, NODE_SHELL_CAPABILITY_MANIFESTS } from './shell-provider.ts';
import {
  createNodeInteractionProvider,
  NODE_INTERACTION_CAPABILITY_MANIFESTS,
} from './interaction-provider.ts';
import {
  createNodeWebFetchProvider,
  NODE_WEB_FETCH_CAPABILITY_MANIFESTS,
} from './web-fetch-provider.ts';

const CANONICAL_MODEL_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    SHARED_LOCAL_TOOL_CONTRACT_LIST.map((contract) => [
      contract.capabilityId,
      contract.toolName,
    ]),
  ),
);

function manifestToToolDefinition(manifest: CapabilityManifest): RuntimeToolDefinition {
  return {
    name: CANONICAL_MODEL_TOOL_NAMES[manifest.capabilityId]
      ?? manifest.capabilityId.replace(/[^A-Za-z0-9_]+/g, '_'),
    capabilityId: manifest.capabilityId,
    description: manifest.description ?? manifest.displayName,
    inputSchema: manifest.inputSchema,
    ...(manifest.modeScopes ? { modeScopes: manifest.modeScopes } : {}),
    metadata: {
      provider: 'runtime-node',
      ...(manifest.riskLevel ? { riskLevel: manifest.riskLevel } : {}),
    },
  };
}

function toCoreContext(
  context: Record<string, unknown>,
  workspaceRoot: string,
): CapabilityExecutionContext {
  const sessionId = typeof context.sessionId === 'string'
    ? context.sessionId
    : 'node-runtime';
  return {
    runId: sessionId,
    sessionId,
    mode: typeof context.mode === 'string' ? context.mode : undefined,
    workspace: { root: workspaceRoot },
    signal: context.signal instanceof AbortSignal ? context.signal : undefined,
    metadata: {
      ...(typeof context.locale === 'string' ? { locale: context.locale } : {}),
      ...(typeof context.conversationId === 'string'
        ? { conversationId: context.conversationId }
        : {}),
      ...(typeof context.projectionId === 'string'
        ? { projectionId: context.projectionId }
        : {}),
    },
  };
}

export function createNodeProviderBundle(
  options: CreateNodeProviderBundleOptions,
): NodeProviderBundle {
  if (!options?.workspaceRoot) {
    throw new TypeError('Node Provider Bundle requires workspaceRoot.');
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  const clock = createProviderRuntimeClock(options);
  const sessionProvider = options.sessionProvider ?? { getSession: () => ({}) };
  const requestCapabilityApproval = options.requestCapabilityApproval
    ?? options.requestPermission;
  const providers = [
    ...(options.file === false ? [] : [
      createNodeFileProvider({
        workspaceRoot,
        requestApproval: requestCapabilityApproval,
        now: clock.now,
        idFactory: clock.idFactory,
        ...(options.file ?? {}),
      }),
      createNodeSearchAggregateProvider({
        workspaceRoot,
        now: clock.now,
        idFactory: clock.idFactory,
      }),
    ]),
    ...(options.shell === false ? [] : [createNodeShellProvider({
      workspaceRoot,
      requestApproval: requestCapabilityApproval,
      now: clock.now,
      idFactory: clock.idFactory,
      ...(options.shell ?? {}),
    })]),
    ...(options.web === false ? [] : [createNodeWebFetchProvider({
      workspaceRoot,
      requestApproval: requestCapabilityApproval,
      now: clock.now,
      idFactory: clock.idFactory,
      ...(options.web ?? {}),
    })]),
    ...(options.interaction === false ? [] : [createNodeInteractionProvider({
      clock,
    })]),
  ];
  const manifests = Object.freeze([
    ...(options.file === false ? [] : NODE_FILE_CAPABILITY_MANIFESTS),
    ...(options.file === false ? [] : NODE_SEARCH_AGGREGATE_CAPABILITY_MANIFESTS),
    ...(options.shell === false ? [] : NODE_SHELL_CAPABILITY_MANIFESTS),
    ...(options.web === false ? [] : NODE_WEB_FETCH_CAPABILITY_MANIFESTS),
    ...(options.interaction === false ? [] : NODE_INTERACTION_CAPABILITY_MANIFESTS),
  ]);
  const toolDefinitions = Object.freeze(manifests.map(manifestToToolDefinition));
  const projection = createRuntimeProjection(toolDefinitions, {
    mode: options.mode,
    now: clock.now,
    metadata: { host: 'node', workspaceRoot },
  });
  const registry = createCapabilityProviderRegistry(providers);

  function createProjectionDeniedExecution(
    call: RuntimeSdkExecuteRequest['call'],
  ): RuntimeSdkProviderExecution {
    return {
      result: createNodeToolResult({
        clock,
        call,
        status: 'denied',
        summary: 'Node tool call was not present in the runtime projection.',
        error: {
          code: 'capability_not_projected',
          message: 'capability_not_projected',
          recoverable: false,
        },
      }),
    };
  }

  const providerExecutor = {
    async execute(
      request: RuntimeSdkExecuteRequest,
      context: Record<string, unknown>,
    ): Promise<RuntimeSdkProviderExecution> {
      if (!projection.tools.some((tool) => tool.capabilityId === request.call.capabilityId)) {
        return createProjectionDeniedExecution(request.call);
      }
      try {
        const result = await registry.execute({
          capabilityId: request.call.capabilityId,
          toolCall: {
            toolCallId: request.call.toolCallId,
            capabilityId: request.call.capabilityId,
            name: typeof request.call.displayName === 'string'
              ? request.call.displayName
              : undefined,
            input: request.call.arguments,
          },
          input: request.call.arguments,
        }, toCoreContext(context, workspaceRoot));
        return {
          result: {
            toolCallId: result.toolCallId,
            capabilityId: result.capabilityId,
            status: result.status,
            ...(result.output === undefined ? {} : { output: result.output }),
            ...(result.outputPreview === undefined ? {} : { outputPreview: result.outputPreview }),
            ...(result.permissionGrant === undefined ? {} : { permissionGrant: result.permissionGrant }),
            ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
            ...(result.error === undefined ? {} : { error: result.error }),
            ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
            ...((result as { control?: unknown }).control === undefined
              ? {}
              : { control: (result as { control?: unknown }).control }),
          },
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
          result: createNodeToolResult({
            clock,
            call: request.call,
            status: 'failed',
            summary: `Node provider failed: ${reason}.`,
            error: { code: reason, message: reason, recoverable: true },
          }),
        };
      }
    },
  };

  function resolveProjectedTool(call: RuntimePipelineToolCall): RuntimeToolDefinition | null {
    const capabilityId = typeof call.capabilityId === 'string' ? call.capabilityId.trim() : '';
    const name = typeof call.name === 'string' ? call.name.trim() : '';
    const projectedTool = capabilityId
      ? projection.tools.find((tool) => tool.capabilityId === capabilityId)
      : projection.tools.find((tool) => tool.name === name);
    if (!projectedTool) return null;
    if (name && projectedTool.name !== name) return null;
    return projectedTool;
  }

  const host = createNodeRuntimeHostAdapter({
    workspaceRoot,
    providerExecutor,
    sessionProvider,
    resultFactory: createNodeResultFactory(clock),
    requestPermission: options.requestPermission,
    hookRunner: options.hookRunner,
    appendHookEvidence: (result, records, finalDecision) => appendNodeHookEvidence(
      result,
      records,
      finalDecision,
      clock,
    ),
  });
  const runtime = createRuntimeSdk({ host, now: clock.now });

  const pipelineToolExecutor: RuntimePipelineToolExecutor<
    unknown,
    RuntimePipelineToolCall,
    RuntimeSdkProviderExecution
  > = {
    async execute(call, context) {
      const projectedTool = resolveProjectedTool(call);
      if (!projectedTool) {
        return {
          call,
          result: createProjectionDeniedExecution({
            toolCallId: call.toolCallId,
            capabilityId: call.capabilityId || call.name || 'unprojected.tool',
            displayName: call.name,
            arguments: call.arguments,
          }),
        };
      }
      const execution = await runtime.execute({
        sessionId: context.run.sessionId,
        conversationId: context.run.conversationId,
        projectionId: projection.createdAt,
        call: {
          toolCallId: call.toolCallId,
          capabilityId: projectedTool.capabilityId,
          displayName: projectedTool.name,
          arguments: call.arguments,
        },
      }, {
        workspaceRoot,
        signal: context.signal,
        requestPermission: options.requestPermission,
        mode: options.mode,
      });
      const control = (execution.result as { control?: { terminal?: unknown; reason?: unknown } } | undefined)?.control
        ?? ((execution.result as { output?: { control?: { terminal?: unknown; reason?: unknown } } } | undefined)?.output?.control);
      const terminal = control?.terminal === true;
      return {
        call,
        result: execution,
        ...(terminal
          ? {
              terminal: true,
              terminalReason: typeof control?.reason === 'string' ? control.reason : 'request_user_input',
            }
          : {}),
      };
    },
  };

  return {
    workspaceRoot,
    manifests,
    toolDefinitions,
    projection,
    providers,
    runtime,
    pipelineToolExecutor,
    events: { subscribe: runtime.subscribe },
  };
}
