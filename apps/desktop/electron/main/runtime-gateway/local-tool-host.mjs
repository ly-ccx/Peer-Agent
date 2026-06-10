import { createCapabilityProviderRegistry } from './capability-provider-registry.mjs';
import { createLocalFileProvider } from './local-file-provider.mjs';
import { createLocalHealthProvider } from './local-health-provider.mjs';
import { createLocalMcpProvider } from './local-mcp-provider.mjs';
import { createLocalShellProvider } from './local-shell-provider.mjs';
import { createFailedClientToolResult, createPermissionGrant } from './tool-result-factory.mjs';

export function createLocalToolHost({
  workspaceRoot,
  userDataPath,
  sessionStore,
  runHealthStub,
  mcpRegistry,
  fileProvider = createLocalFileProvider({ workspaceRoot }),
  shellProvider = createLocalShellProvider({ workspaceRoot, userDataPath }),
  providers,
  extraProviders = [],
}) {
  const mcpProvider = mcpRegistry ? createLocalMcpProvider({ mcpRegistry }) : null;
  const providerRegistry = createCapabilityProviderRegistry({
    providers: providers ?? [
      createLocalHealthProvider({ workspaceRoot, runHealthStub }),
      fileProvider,
      shellProvider,
      ...(mcpProvider ? [mcpProvider] : []),
      ...extraProviders,
    ],
  });

  async function execute(request, executionContext = {}) {
    const call = request.call;
    const locale = sessionStore.getSession().locale;
    const execution = await providerRegistry.execute(request, {
      ...executionContext,
      locale,
      session: sessionStore.getSession(),
      workspaceRoot,
    });

    if (execution) {
      return execution;
    }

    return {
      call,
      grant: createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId }),
      result: createFailedClientToolResult({
        call,
        locale,
        reason: 'unsupported_local_capability',
        dataLevel: call.dataLevel ?? 'D0_public',
      }),
    };
  }

  return {
    execute,
    providerRegistry,
    listShellTasks: shellProvider.listTasks,
    stopShellTask: shellProvider.stopTask,
    stopActiveShellTask: shellProvider.stopActiveTask,
    permissionReview: shellProvider.permissionReview,
  };
}
