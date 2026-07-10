import { createRuntimeSdk } from '@peer-agent/runtime-sdk';
import { createCapabilityProviderRegistry } from './capability-provider-registry.mjs';
import { createLocalFileProvider } from './local-file-provider.mjs';
import { createLocalGoalProvider } from './local-goal-provider.mjs';
import { createLocalHealthProvider } from './local-health-provider.mjs';
import { createLocalInteractionProvider } from './local-interaction-provider.mjs';
import { createLocalMcpProvider } from './local-mcp-provider.mjs';
import { createLocalSearchAggregateProvider } from './local-search-aggregate-provider.mjs';
import { createLocalShellProvider } from './local-shell-provider.mjs';
import { createLocalWebProvider } from './local-web-provider.mjs';
import { createLocalBrowserControlProvider } from './local-browser-control-provider.mjs';
import { createConfiguredHookRunner } from './hook-config.mjs';
import { appendHookEvidence } from './hook-evidence.mjs';
import { createFailedClientToolResult, createPermissionGrant } from './tool-result-factory.mjs';

export function createLocalToolHost({
  workspaceRoot,
  userDataPath,
  sessionStore,
  runHealthStub,
  mcpRegistry,
  mcpCredentialResolver = null,
  fileProvider = createLocalFileProvider({ workspaceRoot }),
  shellProvider = null,
  goalProvider = createLocalGoalProvider(),
  interactionProvider = createLocalInteractionProvider(),
  webProvider = createLocalWebProvider({ userDataPath }),
  browserControlProvider = createLocalBrowserControlProvider({ userDataPath }),
  searchAggregateProvider = createLocalSearchAggregateProvider({ workspaceRoot }),
  providers,
  extraProviders = [],
  hookRunner = null,
}) {
  const activeHookRunner = hookRunner ?? createConfiguredHookRunner({ userDataPath, workspaceRoot });
  const activeShellProvider = shellProvider ?? createLocalShellProvider({
    workspaceRoot,
    userDataPath,
    hookRunner: activeHookRunner,
  });
  const mcpProvider = mcpRegistry ? createLocalMcpProvider({ mcpRegistry, credentialResolver: mcpCredentialResolver }) : null;
  const providerRegistry = createCapabilityProviderRegistry({
    providers: providers ?? [
      createLocalHealthProvider({ workspaceRoot, runHealthStub }),
      fileProvider,
      activeShellProvider,
      goalProvider,
      interactionProvider,
      webProvider,
      browserControlProvider,
      searchAggregateProvider,
      ...(mcpProvider ? [mcpProvider] : []),
      ...extraProviders,
    ],
  });

  const runtime = createRuntimeSdk({
    workspaceRoot,
    host: {
      hookRunner: activeHookRunner,
      executeProvider: async (request, context) => {
        const call = request.call;
        const session = sessionStore.getSession();
        const locale = session.locale;
        const execution = await providerRegistry.execute(request, {
          ...context,
          locale,
          session,
          workspaceRoot,
          sessionId: request.sessionId,
          projectionId: request.projectionId,
          conversationId: request.conversationId,
        });
        return execution ?? {
          call,
          grant: createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId }),
          result: createFailedClientToolResult({
            call,
            locale,
            reason: 'unsupported_local_capability',
            dataLevel: call.dataLevel ?? 'D0_public',
          }),
        };
      },
      approvalPort: {
        requestApproval: async (approvalRequest, context) => {
          const call = approvalRequest.call;
          const requestPermission = context.requestPermission;
          const approval = typeof requestPermission === 'function'
            ? await requestPermission({
              tool: call.capabilityId,
              toolName: call.displayName || call.capabilityId,
              capabilityId: call.capabilityId,
              args: approvalRequest.args,
              workspacePath: approvalRequest.workspacePath,
              reason: approvalRequest.reason,
              confirmation: {
                kind: 'hook-approval',
                reason: 'hook_approval_required',
                hookEvent: 'PreToolUse',
              },
              scope: {
                kind: 'hook-approval',
                capabilityId: call.capabilityId,
              },
              riskLevel: call.riskLevel ?? 'L3_external_write',
              dataLevel: call.dataLevel ?? 'D0_public',
            })
            : null;
          return {
            decision: approval?.granted ? 'allow' : approval ? 'deny' : 'ask',
            approval,
          };
        },
      },
      createBlockedExecution: ({ request, decision, reason, approval }) => {
        const call = request.call;
        const session = sessionStore.getSession();
        const resolvedApproval = approval?.approval;
        const failureReason = decision === 'deny' && !resolvedApproval
          ? 'hook_denied'
          : resolvedApproval?.reason || reason;
        return {
          call,
          grant: resolvedApproval?.grant ?? createPermissionGrant({
            toolCallId: call.toolCallId,
            granted: false,
            scope: call.capabilityId,
          }),
          result: createFailedClientToolResult({
            call,
            locale: session.locale,
            reason: failureReason,
            dataLevel: call.dataLevel ?? 'D0_public',
          }),
        };
      },
      appendHookEvidence,
    },
  });

  async function execute(request, executionContext = {}) {
    return runtime.execute(request, { ...executionContext, workspaceRoot });
  }

  return {
    execute,
    providerRegistry,
    listShellTasks: activeShellProvider.listTasks,
    stopShellTask: activeShellProvider.stopTask,
    stopActiveShellTask: activeShellProvider.stopActiveTask,
    permissionReview: activeShellProvider.permissionReview,
  };
}
