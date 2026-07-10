import { createNodeRuntimeHostAdapter } from '@peer-agent/runtime-node';
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

  const hostAdapter = createNodeRuntimeHostAdapter({
    workspaceRoot,
    providerExecutor: providerRegistry,
    sessionProvider: sessionStore,
    hookRunner: activeHookRunner,
    resultFactory: {
      createPermissionGrant,
      createFailedResult: createFailedClientToolResult,
    },
    appendHookEvidence,
  });
  const runtime = createRuntimeSdk({
    workspaceRoot,
    host: hostAdapter,
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
