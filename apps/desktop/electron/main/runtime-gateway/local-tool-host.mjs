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
import { mostRestrictiveDecision } from './hook-runner.mjs';
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

  async function execute(request, executionContext = {}) {
    const call = request.call;
    const session = sessionStore.getSession();
    const locale = session.locale;
    const baseHookPayload = {
      sessionId: request.sessionId,
      projectionId: request.projectionId,
      conversationId: request.conversationId,
      call,
    };

    const preHookRecords = activeHookRunner?.runPreToolUse
      ? await activeHookRunner.runPreToolUse(baseHookPayload)
      : [];
    const preDecision = mostRestrictiveDecision(preHookRecords);

    if (preDecision === 'deny') {
      const result = createFailedClientToolResult({
        call,
        locale,
        reason: 'hook_denied',
        dataLevel: call.dataLevel ?? 'D0_public',
      });
      return {
        call,
        grant: createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId }),
        result: appendHookEvidence(result, preHookRecords, preDecision),
      };
    }

    if (preDecision === 'ask') {
      const requestPermission = executionContext.requestPermission;
      const approval = typeof requestPermission === 'function'
        ? await requestPermission({
          tool: call.capabilityId,
          toolName: call.displayName || call.capabilityId,
          capabilityId: call.capabilityId,
          args: call.arguments ?? call.argumentsPreview ?? {},
          workspacePath: workspaceRoot,
          reason: preHookRecords.find((record) => record.decision === 'ask')?.reason || 'hook_approval_required',
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
      if (!approval?.granted) {
        const result = createFailedClientToolResult({
          call,
          locale,
          reason: approval?.reason || 'hook_approval_required',
          dataLevel: call.dataLevel ?? 'D0_public',
        });
        return {
          call,
          grant: approval?.grant ?? createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId }),
          result: appendHookEvidence(result, preHookRecords, preDecision),
        };
      }
    }

    const execution = await providerRegistry.execute(request, {
      ...executionContext,
      locale,
      session,
      workspaceRoot,
      sessionId: request.sessionId,
      projectionId: request.projectionId,
      conversationId: request.conversationId,
    });

    const resolvedExecution = execution ?? {
      call,
      grant: createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId }),
      result: createFailedClientToolResult({
        call,
        locale,
        reason: 'unsupported_local_capability',
        dataLevel: call.dataLevel ?? 'D0_public',
      }),
    };

    const postHookRecords = activeHookRunner?.runPostToolUse
      ? await activeHookRunner.runPostToolUse({
          ...baseHookPayload,
          result: resolvedExecution.result,
        })
      : [];

    return {
      ...resolvedExecution,
      result: appendHookEvidence(
        resolvedExecution.result,
        [...preHookRecords, ...postHookRecords],
        mostRestrictiveDecision(preHookRecords),
      ),
    };
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
