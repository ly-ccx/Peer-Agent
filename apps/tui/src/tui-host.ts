import type { RuntimeToolDefinition } from '@peer-agent/runtime-core';
import {
  createConfiguredNodeHookRunner,
  createNodeProviderBundle,
  type NodeRuntimePermissionPrompt,
} from '@peer-agent/runtime-node';
import type {
  RuntimeSdkEvent,
  RuntimeSdkHookRunner,
  RuntimeSdkProviderExecution,
} from '@peer-agent/runtime-sdk';

export type TuiApprovalDecision = 'allow' | 'deny';

export interface PendingApproval {
  readonly prompt: NodeRuntimePermissionPrompt;
  resolve(decision: TuiApprovalDecision): void;
}

export interface TuiHost {
  readonly workspaceRoot: string;
  readonly capabilities: readonly string[];
  readonly toolDefinitions: readonly RuntimeToolDefinition[];
  execute(capabilityId: string, arguments_: Record<string, unknown>): Promise<RuntimeSdkProviderExecution>;
  executeRead(path: string): Promise<RuntimeSdkProviderExecution>;
  executeShell(command: string): Promise<RuntimeSdkProviderExecution>;
  subscribe(listener: (event: RuntimeSdkEvent) => void): () => void;
  subscribeApproval(listener: (approval: PendingApproval | null) => void): () => void;
}

export interface CreateTuiHostOptions {
  readonly workspaceRoot: string;
  readonly userDataPath?: string;
  readonly hookRunner?: RuntimeSdkHookRunner | null;
}

export function createTuiHost(options: string | CreateTuiHostOptions): TuiHost {
  const resolvedOptions = typeof options === 'string' ? { workspaceRoot: options } : options;
  const { workspaceRoot } = resolvedOptions;
  const hookRunner = resolvedOptions.hookRunner ?? createConfiguredNodeHookRunner({
    userDataPath: resolvedOptions.userDataPath,
    workspaceRoot,
  });
  const approvalListeners = new Set<(approval: PendingApproval | null) => void>();
  let activeApproval: PendingApproval | null = null;

  const publishApproval = (approval: PendingApproval | null) => {
    activeApproval = approval;
    for (const listener of approvalListeners) listener(approval);
  };

  const bundle = createNodeProviderBundle({
    workspaceRoot,
    hookRunner,
    requestPermission(prompt) {
      return new Promise((resolve) => {
        publishApproval({
          prompt,
          resolve(decision) {
            publishApproval(null);
            resolve({
              granted: decision === 'allow',
              reason: decision === 'allow' ? 'approved_in_tui' : 'denied_in_tui',
            });
          },
        });
      });
    },
  });

  let callSequence = 0;
  const execute = (capabilityId: string, args: Record<string, unknown>) =>
    bundle.runtime.execute({
      sessionId: 'tui-session',
      projectionId: bundle.projection.createdAt,
      call: {
        toolCallId: `tui-tool-${++callSequence}`,
        capabilityId,
        arguments: args,
      },
    });

  return {
    workspaceRoot: bundle.workspaceRoot,
    capabilities: bundle.projection.tools.map((tool) => tool.capabilityId),
    toolDefinitions: bundle.toolDefinitions,
    execute,
    executeRead: (path) => execute('local.file.read', { path }),
    executeShell: (command) => execute('local.shell.exec', { command }),
    subscribe: bundle.events.subscribe,
    subscribeApproval(listener) {
      approvalListeners.add(listener);
      listener(activeApproval);
      return () => approvalListeners.delete(listener);
    },
  };
}
