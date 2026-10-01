import { createNodeRuntimeHostAdapter } from '@peer-agent/runtime-node';
import { createRuntimeSdk } from '@peer-agent/runtime-sdk';
import { createCapabilityProviderRegistry } from './capability-provider-registry.mjs';
import { createLocalAutomationProposalProvider } from './local-automation-proposal-provider.mjs';
import { createLocalFileProvider } from './local-file-provider.mjs';
import { createLocalDelegationProvider } from './local-delegation-provider.mjs';
import { liveDelegationSupervisor, liveObjectiveService, delegationStoreDir } from '../project-agent/delegation-port.mjs';
import { liveDeliveryFacts } from '../project-agent/delivery-facts-port.mjs';
import { createDesktopReplyComposer } from '../project-agent/reply-composer-port.mjs';
import { liveSessionVerification } from '../project-agent/session-verification.mjs';
import { liveProjectProactivity } from '../project-agent/proactivity-port.mjs';
import { createLocalMemoryProvider } from './local-memory-provider.mjs';
import { liveMemoryGate } from '../project-agent/memory-gate-port.mjs';
import { installMemoryIndex } from '../project-agent/memory-index-port.mjs';
import { createLocalGoalProvider } from './local-goal-provider.mjs';
import { createLocalInteractionProvider } from './local-interaction-provider.mjs';
import { createLocalMcpProvider } from './local-mcp-provider.mjs';
import { createLocalSearchAggregateProvider } from './local-search-aggregate-provider.mjs';
import { createLocalShellProvider } from './local-shell-provider.mjs';
import { getApplicationShellTasks } from './application-shell-tasks.mjs';
import { getApplicationShellSessions } from './application-shell-sessions.mjs';
import { createLocalWebProvider } from './local-web-provider.mjs';
import { createLocalBrowserControlProvider } from './local-browser-control-provider.mjs';
import { createLocalExternalBrowserProvider } from './local-external-browser-provider.mjs';
import { createConfiguredHookRunner } from './hook-config.mjs';
import { appendHookEvidence } from './hook-evidence.mjs';
import { createFailedClientToolResult, createPermissionGrant } from './tool-result-factory.mjs';

export function createLocalToolHost({
  workspaceRoot,
  userDataPath,
  sessionStore,
  mcpRegistry,
  mcpCredentialResolver = null,
  fileProvider = createLocalFileProvider({ workspaceRoot }),
  shellProvider = null,
  goalProvider = createLocalGoalProvider(),
  delegationProvider = null,
  memoryProvider = null,
  interactionProvider = createLocalInteractionProvider(),
  webProvider = createLocalWebProvider({ userDataPath }),
  ensureBrowserReady = null,
  // 受治理的网页 UI 交付（可选）：只有显式声明计划归属的截图才会走它。
  webUiCapture = null,
  browserControlProvider = createLocalBrowserControlProvider({ userDataPath, ensureBrowserReady, webUiCapture }),
  externalBrowserProvider = createLocalExternalBrowserProvider({ userDataPath }),
  searchAggregateProvider = createLocalSearchAggregateProvider({ workspaceRoot }),
  automationProposalService = null,
  automationProposalProvider = createLocalAutomationProposalProvider({
    proposalService: automationProposalService,
  }),
  providers,
  extraProviders = [],
  hookRunner = null,
  onRuntimeEvent = null,
  executionGate = null,
}) {
  const activeMemoryProvider = memoryProvider ?? createLocalMemoryProvider({
    enabled: (workspaceId) => liveMemoryGate().enabled(workspaceId),
  });
  installMemoryIndex({
    rebuild() {
      activeMemoryProvider.rebuildIndex?.();
    },
  });
  const activeDelegationProvider = delegationProvider ?? createLocalDelegationProvider({
    supervisor: liveDelegationSupervisor(),
    objectives: liveObjectiveService(),
    storeDir: delegationStoreDir,
    verification: liveSessionVerification(),
    proactivity: liveProjectProactivity(),
    replyComposer: createDesktopReplyComposer({
      readDelivery: (view) => liveDeliveryFacts().read(view),
    }),
  });
  const activeHookRunner = hookRunner ?? createConfiguredHookRunner({ userDataPath, workspaceRoot });
  const activeShellProvider = shellProvider ?? createLocalShellProvider({
    workspaceRoot,
    userDataPath,
    ...(userDataPath ? {
      taskManager: getApplicationShellTasks(userDataPath),
      sessionManager: getApplicationShellSessions(userDataPath, workspaceRoot),
    } : {}),
    hookRunner: activeHookRunner,
  });
  const mcpProvider = mcpRegistry ? createLocalMcpProvider({ mcpRegistry, credentialResolver: mcpCredentialResolver }) : null;
  const providerRegistry = createCapabilityProviderRegistry({
    providers: providers ?? [
      fileProvider,
      activeShellProvider,
      goalProvider,
      activeDelegationProvider,
      activeMemoryProvider,
      interactionProvider,
      automationProposalProvider,
      webProvider,
      browserControlProvider,
      externalBrowserProvider,
      searchAggregateProvider,
      ...(mcpProvider ? [mcpProvider] : []),
      ...extraProviders,
    ],
  });

  const hostAdapter = createNodeRuntimeHostAdapter({
    ...(executionGate ? { executionGate } : {}),
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
  const unsubscribeRuntimeEvents = typeof onRuntimeEvent === 'function'
    ? runtime.subscribe(onRuntimeEvent)
    : () => {};

  async function execute(request, executionContext = {}) {
    return runtime.execute(request, { ...executionContext, workspaceRoot });
  }

  return {
    execute,
    runtime,
    unsubscribeRuntimeEvents,
    providerRegistry,
    listShellTasks: activeShellProvider.listTasks,
    stopShellTask: activeShellProvider.stopTask,
    stopActiveShellTask: activeShellProvider.stopActiveTask,
    permissionReview: activeShellProvider.permissionReview,
  };
}
