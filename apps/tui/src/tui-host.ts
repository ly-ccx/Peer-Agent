import { AsyncLocalStorage } from 'node:async_hooks';

import type { LocalAccessLevel } from '@peer-agent/protocol';
import type { RuntimeToolDefinition } from '@peer-agent/runtime-core';
import {
  createConfiguredNodeHookRunner,
  createNodeProviderBundle,
  NODE_SHELL_RISK_ORDER,
  type NodeRuntimePermissionPrompt,
} from '@peer-agent/runtime-node';
import type {
  RuntimeSdkEvent,
  RuntimeSdkHookRunner,
  RuntimeSdkProviderExecution,
} from '@peer-agent/runtime-sdk';

import { normalizeTuiMode, TUI_RUNTIME_MODES, type TuiMode } from './tui-mode.ts';
import { normalizeLocalAccessLevel } from './tui-permission-policy.ts';

export type TuiApprovalDecision = 'allow-once' | 'allow-session' | 'deny';

export interface PendingApproval {
  readonly prompt: NodeRuntimePermissionPrompt;
  readonly sessionId?: string;
  resolve(decision: TuiApprovalDecision): void;
}

export interface TuiExecutionContext {
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly turnId: string;
  readonly turnIndex: number;
  readonly mode?: TuiMode;
  readonly signal?: AbortSignal;
}

export interface TuiHost {
  readonly workspaceRoot: string;
  readonly capabilities: readonly string[];
  readonly toolDefinitions: readonly RuntimeToolDefinition[];
  getAccessLevel(): LocalAccessLevel;
  setAccessLevel(value: unknown): LocalAccessLevel;
  capabilitiesForMode?(mode: TuiMode): readonly string[];
  toolDefinitionsForMode?(mode: TuiMode): readonly RuntimeToolDefinition[];
  execute(
    capabilityId: string,
    arguments_: Record<string, unknown>,
    context?: TuiExecutionContext,
  ): Promise<RuntimeSdkProviderExecution>;
  executeRead(path: string, context?: TuiExecutionContext): Promise<RuntimeSdkProviderExecution>;
  executeShell(command: string, context?: TuiExecutionContext): Promise<RuntimeSdkProviderExecution>;
  subscribe(listener: (event: RuntimeSdkEvent) => void): () => void;
  subscribeApproval(listener: (approval: PendingApproval | null) => void): () => void;
}

export interface CreateTuiHostOptions {
  readonly workspaceRoot: string;
  readonly userDataPath?: string;
  readonly hookRunner?: RuntimeSdkHookRunner | null;
  readonly accessLevel?: LocalAccessLevel;
  readonly persistAccessLevel?: (accessLevel: LocalAccessLevel) => void;
}

function isNodeShellRiskLevel(value: unknown): value is keyof typeof NODE_SHELL_RISK_ORDER {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(NODE_SHELL_RISK_ORDER, value);
}

function automaticAccessDecision(
  accessLevel: LocalAccessLevel,
  prompt: NodeRuntimePermissionPrompt,
): { readonly granted: true; readonly reason: string } | null {
  if (accessLevel === 'full_local') {
    return { granted: true, reason: 'local_access_level_full' };
  }
  if (accessLevel !== 'session_local' || prompt.confirmation.kind !== 'capability-approval') {
    return null;
  }
  if (prompt.confirmation.approvalKind === 'file-write') {
    return { granted: true, reason: 'local_access_level_session' };
  }
  if (
    prompt.confirmation.approvalKind === 'shell-exec'
    && isNodeShellRiskLevel(prompt.riskLevel)
    && NODE_SHELL_RISK_ORDER[prompt.riskLevel] <= NODE_SHELL_RISK_ORDER.L3_external_write
  ) {
    return { granted: true, reason: 'local_access_level_session' };
  }
  return null;
}

export function createTuiHost(options: string | CreateTuiHostOptions): TuiHost {
  const resolvedOptions = typeof options === 'string' ? { workspaceRoot: options } : options;
  const { workspaceRoot } = resolvedOptions;
  const hookRunner = resolvedOptions.hookRunner ?? createConfiguredNodeHookRunner({
    userDataPath: resolvedOptions.userDataPath,
    workspaceRoot,
  });
  const approvalListeners = new Set<(approval: PendingApproval | null) => void>();
  const executionContext = new AsyncLocalStorage<TuiExecutionContext>();
  const sessionApprovals = new Set<string>();
  const approvalQueue: PendingApproval[] = [];
  let activeApproval: PendingApproval | null = null;
  let accessLevel = normalizeLocalAccessLevel(resolvedOptions.accessLevel);

  const setAccessLevel = (value: unknown): LocalAccessLevel => {
    accessLevel = normalizeLocalAccessLevel(value);
    try {
      resolvedOptions.persistAccessLevel?.(accessLevel);
    } catch {
      // Runtime truth still changes for this session when shared preference persistence is unavailable.
    }
    return accessLevel;
  };

  const sessionApprovalKey = (
    sessionId: string,
    prompt: NodeRuntimePermissionPrompt,
  ) => JSON.stringify([
    sessionId,
    prompt.capabilityId,
    prompt.workspacePath ?? workspaceRoot,
  ]);

  const publishApproval = (approval: PendingApproval | null) => {
    activeApproval = approval;
    for (const listener of approvalListeners) listener(approval);
  };

  const showNextApproval = () => {
    if (activeApproval || approvalQueue.length === 0) return;
    publishApproval(approvalQueue.shift() ?? null);
  };

  const completeApproval = () => {
    publishApproval(null);
    showNextApproval();
  };

  const requestPermission = (prompt: NodeRuntimePermissionPrompt) => {
    const context = executionContext.getStore();
    const approvalKey = context
      ? sessionApprovalKey(context.sessionId, prompt)
      : null;
    if (approvalKey && sessionApprovals.has(approvalKey)) {
      return Promise.resolve({
        granted: true,
        reason: 'approved_for_tui_session',
      });
    }

    const automaticDecision = automaticAccessDecision(accessLevel, prompt);
    if (automaticDecision) return Promise.resolve(automaticDecision);

    if (approvalListeners.size === 0) {
      return Promise.resolve({
        granted: false,
        reason: 'tui_approval_unavailable',
      });
    }

    return new Promise<{ granted: boolean; reason: string }>((resolve) => {
      let settled = false;
      approvalQueue.push({
        prompt,
        ...(context ? { sessionId: context.sessionId } : {}),
        resolve(decision) {
          if (settled) return;
          settled = true;
          if (decision === 'allow-session' && approvalKey) {
            sessionApprovals.add(approvalKey);
          }
          completeApproval();
          resolve({
            granted: decision !== 'deny',
            reason: decision === 'allow-session'
              ? approvalKey
                ? 'approved_for_tui_session'
                : 'approved_once_without_session_context'
              : decision === 'allow-once'
                ? 'approved_once_in_tui'
                : 'denied_in_tui',
          });
        },
      });
      showNextApproval();
    });
  };

  const bundles = new Map<TuiMode, ReturnType<typeof createNodeProviderBundle>>();
  for (const mode of TUI_RUNTIME_MODES) {
    bundles.set(mode, createNodeProviderBundle({
      workspaceRoot,
      mode,
      hookRunner,
      requestPermission,
    }));
  }
  const bundleForMode = (mode: TuiMode) => bundles.get(mode)!;
  const defaultBundle = bundleForMode('chat');

  let callSequence = 0;
  const execute = (
    capabilityId: string,
    args: Record<string, unknown>,
    context?: TuiExecutionContext,
  ) => {
    const mode = normalizeTuiMode(context?.mode);
    const bundle = bundleForMode(mode);
    const run = () => bundle.runtime.execute({
      sessionId: context?.sessionId ?? 'tui-session',
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      projectionId: bundle.projection.createdAt,
      call: {
        toolCallId: `tui-tool-${++callSequence}`,
        capabilityId,
        arguments: args,
      },
    }, {
      workspaceRoot: bundle.workspaceRoot,
      mode,
      ...(context ? {
        sessionId: context.sessionId,
        conversationId: context.conversationId,
        streamId: context.streamId,
        turnId: context.turnId,
        turnIndex: context.turnIndex,
        signal: context.signal,
      } : {}),
    });
    return context ? executionContext.run({ ...context, mode }, run) : run();
  };

  return {
    workspaceRoot: defaultBundle.workspaceRoot,
    // Default surface uses the mode-projected tool set, not the unfiltered
    // provider catalog. Otherwise the model would see write/shell tools even
    // when the active mode projection excludes them.
    capabilities: defaultBundle.projection.tools.map((tool) => tool.capabilityId),
    toolDefinitions: defaultBundle.projection.tools,
    getAccessLevel: () => accessLevel,
    setAccessLevel,
    capabilitiesForMode(mode) {
      return bundleForMode(normalizeTuiMode(mode)).projection.tools.map((tool) => tool.capabilityId);
    },
    toolDefinitionsForMode(mode) {
      return bundleForMode(normalizeTuiMode(mode)).projection.tools;
    },
    execute,
    executeRead: (path, context) => execute('local.file.read', { path }, context),
    executeShell: (command, context) => execute('local.shell.exec', { command }, context),
    subscribe(listener) {
      const unsubscribes = [...bundles.values()].map((bundle) => bundle.events.subscribe(listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    subscribeApproval(listener) {
      approvalListeners.add(listener);
      listener(activeApproval);
      return () => {
        approvalListeners.delete(listener);
        if (approvalListeners.size > 0) return;
        sessionApprovals.clear();
        while (activeApproval) activeApproval.resolve('deny');
      };
    },
  };
}
