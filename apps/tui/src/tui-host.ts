import { AsyncLocalStorage } from 'node:async_hooks';
import { homedir } from 'node:os';
import path from 'node:path';

import type { LocalAccessLevel } from '@peer-agent/protocol';
import {
  collectToolEvidenceRefs,
  canonicalizeLocalCapabilityId,
  isRuntimeToolAvailableInMode,
  type RuntimeToolDefinition,
  type CapabilityManifest,
  createRuntimeProjection,
} from '@peer-agent/runtime-core';
import {
  createConfiguredNodeHookRunner,
  createNodeProviderBundle,
  createNodeShellSessionManager,
  createNodeShellTaskManager,
  NODE_SHELL_RISK_ORDER,
  evaluateProjectAgentTurn,
  evaluateWorkSessionWrite,
  createApprovalStore,
  digestApprovalArgs,
  createFailedClientToolResult,
  fileEvidencePreview,
  createNodeRuntimeHostAdapter,
  createNodeResultFactory,
  createProviderRuntimeClock,
  appendNodeHookEvidence,
  createGoalPlanStore,
  type NodeRuntimePermissionPrompt,
} from '@peer-agent/runtime-node';
import { createRuntimeSdk,
  type RuntimeSdkEvent,
  type RuntimeSdkHookRunner,
  type RuntimeSdkProviderExecution,
} from '@peer-agent/runtime-sdk';

import { createTuiGoalBridge } from './goal-bridge.ts';
import { createTuiSkillMcpBridge } from './skill-mcp-bridge.ts';
import {
  normalizeTuiRuntimeMode,
  TUI_RUNTIME_MODES,
  type TuiRuntimeMode,
} from './tui-mode.ts';
import { normalizeLocalAccessLevel } from './tui-permission-policy.ts';

export type TuiApprovalDecision = 'allow-once' | 'allow-session' | 'deny';

export interface PendingApproval {
  readonly prompt: NodeRuntimePermissionPrompt;
  readonly toolCallId?: string;
  readonly sessionId?: string;
  resolve(decision: TuiApprovalDecision): void;
}

export interface TuiExecutionContext {
  readonly toolCallId?: string;
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly streamId?: string;
  readonly turnId: string;
  readonly turnIndex: number;
  readonly mode?: TuiRuntimeMode;
  readonly toolContext?: Record<string, unknown>;
  readonly project?: {
    readonly workspaceId: string;
    readonly sessionId?: string;
    readonly planId?: string;
    readonly readOnly?: boolean;
    readonly approver?: boolean;
    readonly holdsLease: () => boolean;
  };
  readonly signal?: AbortSignal;
}

export interface TuiCapabilityProvider {
  readonly manifests: readonly CapabilityManifest[];
  readonly toolDefinitions: readonly RuntimeToolDefinition[];
  execute(capabilityId: string, args: Record<string, unknown>, context: TuiExecutionContext): Promise<RuntimeSdkProviderExecution>;
}

export interface TuiHost {
  readonly workspaceRoot: string;
  readonly capabilities: readonly string[];
  readonly toolDefinitions: readonly RuntimeToolDefinition[];
  /** Shared Desktop goal-plan bridge (create/update/get + intake gate). */
  readonly goalBridge?: ReturnType<typeof createTuiGoalBridge>;
  /** Shared local Skill/MCP registries, projections, and providers. */
  readonly skillMcpBridge?: ReturnType<typeof createTuiSkillMcpBridge>;
  getAccessLevel(): LocalAccessLevel;
  setAccessLevel(value: unknown): LocalAccessLevel;
  capabilitiesForMode?(mode: TuiRuntimeMode): readonly string[];
  toolDefinitionsForMode?(mode: TuiRuntimeMode): readonly RuntimeToolDefinition[];
  execute(
    capabilityId: string,
    arguments_: Record<string, unknown>,
    context?: TuiExecutionContext,
  ): Promise<RuntimeSdkProviderExecution>;
  executeRead(path: string, context?: TuiExecutionContext): Promise<RuntimeSdkProviderExecution>;
  executeShell(command: string, context?: TuiExecutionContext): Promise<RuntimeSdkProviderExecution>;
  subscribe(listener: (event: RuntimeSdkEvent) => void): () => void;
  subscribeApproval(listener: (approval: PendingApproval | null) => void): () => void;
  dispose(): Promise<void>;
}

export interface CreateTuiHostOptions {
  readonly workspaceRoot: string;
  readonly userDataPath?: string;
  readonly hookRunner?: RuntimeSdkHookRunner | null;
  readonly accessLevel?: LocalAccessLevel;
  readonly persistAccessLevel?: (accessLevel: LocalAccessLevel) => void;
  readonly providers?: readonly TuiCapabilityProvider[];
  readonly oneTimeApprovals?: { match(input: object): boolean };
  readonly goalPlanStore?: ReturnType<typeof createGoalPlanStore>;
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
  const userDataPath = resolvedOptions.userDataPath
    ?? process.env.PEER_AGENT_HOME
    ?? path.join(homedir(), '.peer-agent');
  const hookRunner = resolvedOptions.hookRunner ?? createConfiguredNodeHookRunner({
    userDataPath,
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
    if (context?.signal?.aborted || context?.project && !context.project.holdsLease()) {
      return Promise.resolve({ granted: false, reason: 'host_unavailable' });
    }
    if (context?.project && resolvedOptions.oneTimeApprovals?.match({
      capabilityId: prompt.capabilityId, argsDigest: digestApprovalArgs(prompt.args), at: Date.now(),
      sessionId: context.project.sessionId, workspaceId: context.project.workspaceId,
    })) return Promise.resolve({ granted: true, reason: 'approved_once_after_resume' });
    const approvalKey = context
      ? sessionApprovalKey(context.sessionId, prompt)
      : null;
    if (approvalKey && sessionApprovals.has(approvalKey)) {
      return Promise.resolve({
        granted: true,
        reason: 'approved_for_tui_session',
      });
    }

    if (context?.project?.approver === false) {
      return Promise.resolve({ granted: false, reason: 'ephemeral_no_approver' });
    }
    const automaticDecision = automaticAccessDecision(context?.mode === 'project_agent' ? 'restricted_local' : accessLevel, prompt);
    if (automaticDecision) return Promise.resolve(automaticDecision);

    if (approvalListeners.size === 0) {
      return Promise.resolve({
        granted: false,
        reason: 'tui_approval_unavailable',
      });
    }

    return new Promise<{ granted: boolean; reason: string }>((resolve) => {
      let settled = false;
      const project = context?.project;
      const store = project ? createApprovalStore({ rootDir: path.join(userDataPath, 'project-runtime') }) : null;
      const record = project ? store?.append({
        approvalId: context.toolCallId, workspaceId: project.workspaceId,
        conversationId: context.conversationId, streamId: context.streamId,
        sessionId: project.sessionId, planId: project.planId,
        capabilityId: prompt.capabilityId, summary: prompt.reason,
        riskLevel: typeof prompt.riskLevel === 'string' ? prompt.riskLevel : null, argsDigest: digestApprovalArgs(prompt.args), state: 'open',
      }) : null;
      const abort = () => approval.resolve('deny');
      const approval: PendingApproval = {
        prompt,
        ...(context ? { sessionId: context.sessionId, toolCallId: context.toolCallId } : {}),
        resolve(decision) {
          if (settled) return;
          settled = true;
          context?.signal?.removeEventListener('abort', abort);
          const permitted = decision !== 'deny' && !context?.signal?.aborted && (!project || project.holdsLease());
          if (record) store?.append({ ...record, state: permitted ? 'approved' : context?.signal?.aborted ? 'stale' : 'denied',
            decidedAt: new Date().toISOString(), decidedBy: 'local_ui' });
          if (permitted && decision === 'allow-session' && approvalKey) sessionApprovals.add(approvalKey);
          if (activeApproval === approval) completeApproval();
          else { const index = approvalQueue.indexOf(approval); if (index >= 0) approvalQueue.splice(index, 1); }
          resolve({ granted: permitted, reason: permitted ? decision === 'allow-session' ? approvalKey ? 'approved_for_tui_session' : 'approved_once_without_session_context' : 'approved_once_in_tui' : 'denied_in_tui' });
        },
      };
      context?.signal?.addEventListener('abort', abort, { once: true });
      if (context?.signal?.aborted) { abort(); return; }
      approvalQueue.push(approval);
      showNextApproval();
    });
  };

  const artifactRoot = path.join(userDataPath, 'shell-artifacts');
  const shellTaskManager = createNodeShellTaskManager({
    workspaceRoot,
    artifactRoot,
  });
  const shellSessionManager = createNodeShellSessionManager({ workspaceRoot });
  const bundles = new Map<TuiRuntimeMode, ReturnType<typeof createNodeProviderBundle>>();
  for (const mode of TUI_RUNTIME_MODES) {
    bundles.set(mode, createNodeProviderBundle({
      workspaceRoot,
      mode,
      hookRunner,
      requestPermission,
      executionGate: call => projectAuthorityReason(executionContext.getStore(), call.capabilityId),
      shell: {
        taskManager: shellTaskManager,
        sessionManager: shellSessionManager,
        artifactRoot,
      },
    }));
  }
  const bundleForMode = (mode: TuiRuntimeMode) => bundles.get(mode)!;
  const defaultBundle = bundleForMode('chat');
  // Shared on-disk goal plan store + goal tools (aligned with Desktop).
  const goalBridge = createTuiGoalBridge({
    storeDir: path.join(userDataPath, 'goal-plans'),
    store: resolvedOptions.goalPlanStore,
  });
  const skillMcpBridge = createTuiSkillMcpBridge({ userDataPath, workspacePath: workspaceRoot });
  const providerClock = createProviderRuntimeClock();
  const providerProjection = (mode: TuiRuntimeMode) => createRuntimeProjection([
    ...(resolvedOptions.providers?.flatMap(provider => provider.toolDefinitions) ?? []),
    ...goalBridge.toolDefinitions, ...skillMcpBridge.toolDefinitions(),
  ], { mode });
  const providerRuntime = createRuntimeSdk({ host: createNodeRuntimeHostAdapter({
    executionGate: request => projectAuthorityReason(executionContext.getStore(), request.call.capabilityId),
    workspaceRoot, hookRunner, requestPermission,
    sessionProvider: { getSession: () => ({}) },
    resultFactory: createNodeResultFactory(providerClock),
    appendHookEvidence: (result, records, decision) => appendNodeHookEvidence(result, records, decision, providerClock),
    providerExecutor: { async execute(request, context) {
      const localContext = executionContext.getStore();
      const mode = normalizeTuiRuntimeMode(context.mode);
      const provider = resolvedOptions.providers?.find(item => item.manifests.some(manifest => manifest.capabilityId === request.call.capabilityId));
      if (!localContext || !providerProjection(mode).tools.some(tool => tool.capabilityId === request.call.capabilityId)) return {
        call: request.call,
        result: createFailedClientToolResult({ call: request.call, locale: 'zh-CN', reason: 'capability_not_projected' }),
      };
      if (localContext.signal?.aborted || localContext.project && !localContext.project.holdsLease()) return {
        call: request.call,
        result: createFailedClientToolResult({ call: request.call, locale: 'zh-CN', reason: 'host_unavailable' }),
      };
      if (!provider && goalBridge.isGoalCapability(request.call.capabilityId)) return goalBridge.execute({
        capabilityId: request.call.capabilityId, args: request.call.arguments as Record<string, unknown>,
        conversationId: localContext.conversationId, mode, workspaceRoot, toolCallId: request.call.toolCallId,
      });
      if (!provider && skillMcpBridge.isCapability(request.call.capabilityId)) return skillMcpBridge.execute({
        capabilityId: request.call.capabilityId, args: request.call.arguments as Record<string, unknown>,
        toolCallId: request.call.toolCallId, mode, requestPermission: requestPermission as never,
      });
      if (!provider) return null;
      return provider.execute(request.call.capabilityId, request.call.arguments as Record<string, unknown>, {
        ...localContext, toolContext: { ...localContext.toolContext, ...(context.toolContext as object) },
      });
    } },
  }) });

  function projectAuthorityReason(context: TuiExecutionContext | undefined, capabilityId: string) {
    if (context?.signal?.aborted) return 'execution_cancelled';
    if (context?.project && !context.project.holdsLease()) return 'host_unavailable';
    const plan = context?.project?.planId ? goalBridge.store.getPlan(context.project.planId) : null;
    const readOnly = plan?.delegationOrigin?.readOnly === true || context?.project?.readOnly === true;
    const bundle = bundleForMode(normalizeTuiRuntimeMode(context?.mode));
    const manifest = [...bundle.manifests, ...(resolvedOptions.providers?.flatMap(item => item.manifests) ?? [])]
      .find(item => item.capabilityId === capabilityId);
    const gate = evaluateWorkSessionWrite({ delegationOrigin: { readOnly } }, { capabilityId, riskLevel: manifest?.riskLevel });
    return gate.allowed ? null : gate.error ?? 'read_only';
  }

  const recordExecutionEvidence = (
    execution: RuntimeSdkProviderExecution,
    options: {
      readonly mode: TuiRuntimeMode;
      readonly capabilityId: string;
      readonly conversationId?: string;
      readonly streamId?: string;
      readonly toolCallId: string;
    },
  ): RuntimeSdkProviderExecution => {
    execution = { ...execution, call: { toolCallId: options.toolCallId, capabilityId: options.capabilityId } };
    const nodeGrant = execution.result.permissionGrant as any;
    if (!execution.grant && nodeGrant?.decision) execution = { ...execution, grant: {
      ...nodeGrant, toolCallId: options.toolCallId, granted: nodeGrant.decision === 'allow',
      scope: options.capabilityId, duration: nodeGrant.decision === 'allow' ? 'once' : 'denied', decidedAt: nodeGrant.grantedAt,
    } };
    const evidenceRefs = collectToolEvidenceRefs({
      toolCallId: options.toolCallId,
      execution,
    });
    if (evidenceRefs.length === 0) return execution;
    try {
      const bodyPreview = fileEvidencePreview(execution);
      const toolName = withBridgeTools(options.mode, bundleForMode(options.mode).projection.tools).find(tool => tool.capabilityId === options.capabilityId)?.name;
      const userArtifacts = (execution.result.evidence as any)?.userArtifacts;
      goalBridge.store.recordEvidenceRefs({
        toolName, ...(bodyPreview ? { bodyPreview } : {}),
        ...(Array.isArray(userArtifacts) ? { userArtifacts } : {}),
        conversationId: options.conversationId ?? null,
        streamId: options.streamId ?? null,
        toolCallId: options.toolCallId,
        capabilityId: options.capabilityId,
        evidenceRefs,
        artifactRefs: evidenceRefs.filter((ref) => !ref.startsWith('tool-result://')),
      });
    } catch (error) {
      console.warn('[tui-host] failed to register EvidenceIndex refs:', error);
    }
    return execution;
  };

  let callSequence = 0;
  const executeInternal = async (
    capabilityId: string,
    args: Record<string, unknown>,
    context?: TuiExecutionContext,
  ) => {
    capabilityId = canonicalizeLocalCapabilityId(capabilityId);
    const mode = normalizeTuiRuntimeMode(context?.mode);
    const bundle = bundleForMode(mode);
    const toolCallId = context?.toolCallId ?? `tui-tool-${++callSequence}`;
    const gate = evaluateProjectAgentTurn({ mode, capabilityId });
    const blocked = !gate.allowed ? gate.reason
      : projectAuthorityReason(context, capabilityId)
      || (mode === 'memory_curator' ? 'capability_not_projected' : null);
    if (blocked) return { result: createFailedClientToolResult({
      call: { toolCallId, capabilityId }, locale: 'zh-CN', reason: blocked, status: 'denied',
    }) } as RuntimeSdkProviderExecution;

    const provider = resolvedOptions.providers?.find(item => item.manifests.some(manifest => manifest.capabilityId === capabilityId));
    if (provider && context) {
      if (!provider.toolDefinitions.some(tool => tool.capabilityId === capabilityId && isRuntimeToolAvailableInMode(tool, mode))) {
        return { result: createFailedClientToolResult({ call: { toolCallId, capabilityId }, locale: 'zh-CN', reason: 'capability_not_projected' }) } as RuntimeSdkProviderExecution;
      }
      const localContext = { ...context, mode, toolCallId };
      const result = await executionContext.run(localContext, () => providerRuntime.execute({
        sessionId: context.sessionId, conversationId: context.conversationId,
        projectionId: providerProjection(mode).createdAt,
        call: { toolCallId, capabilityId, arguments: args },
      }, localContext as unknown as Record<string, unknown>));
      return recordExecutionEvidence(result, { mode, capabilityId, conversationId: context.conversationId, streamId: context.streamId, toolCallId });
    }

    // Goal intake gate: block shell/write until a plan exists for this conversation.
    const intake = goalBridge.evaluateIntake({
      mode,
      conversationId: context?.conversationId,
      capabilityId,
    });
    if (!intake.allowed) {
      return {
        result: {
          toolCallId,
          capabilityId,
          status: 'failed',
          summary: 'Blocked by Goal intake gate',
          error: { message: intake.reason },
          output: { ok: false, error: intake.reason },
          outputPreview: intake.reason,
          evidence: {
            summary: intake.reason,
            returnedToCloud: true,
            dataLevel: 'D1_internal',
          },
        },
      } as RuntimeSdkProviderExecution;
    }

    if (goalBridge.isGoalCapability(capabilityId)) {
      const execution = await executeBridge(capabilityId, args, { ...context, mode, toolCallId });
      return recordExecutionEvidence(execution, {
        mode,
        capabilityId,
        conversationId: context?.conversationId,
        streamId: context?.streamId,
        toolCallId,
      });
    }

    if (skillMcpBridge.isCapability(capabilityId)) {
      if (!skillMcpBridge.toolDefinitions().some(tool => tool.capabilityId === capabilityId && isRuntimeToolAvailableInMode(tool, mode))) {
        return { result: createFailedClientToolResult({ call: { toolCallId, capabilityId }, locale: 'zh-CN', reason: 'capability_not_projected' }) } as RuntimeSdkProviderExecution;
      }
      const execution = await executeBridge(capabilityId, args, { ...context, mode, toolCallId });
      return recordExecutionEvidence(execution, {
        mode,
        capabilityId,
        conversationId: context?.conversationId,
        streamId: context?.streamId,
        toolCallId,
      });
    }

    const run = () => bundle.runtime.execute({
      sessionId: context?.sessionId ?? 'tui-session',
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      projectionId: bundle.projection.createdAt,
      call: {
        toolCallId,
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
    const execution = await (context
      ? executionContext.run({ ...context, mode, toolCallId }, run)
      : run());
    return recordExecutionEvidence(execution, {
      mode,
      capabilityId,
      conversationId: context?.conversationId,
      streamId: context?.streamId,
      toolCallId,
    });
  };

  function executeBridge(capabilityId: string, args: Record<string, unknown>, context: Partial<TuiExecutionContext> & { mode: TuiRuntimeMode; toolCallId: string }) {
    const localContext = { sessionId: 'tui-session', turnId: context.toolCallId, turnIndex: 0, ...context } as TuiExecutionContext;
    return executionContext.run(localContext, () => providerRuntime.execute({
      sessionId: localContext.sessionId, conversationId: localContext.conversationId,
      projectionId: providerProjection(context.mode).createdAt,
      call: { capabilityId, toolCallId: context.toolCallId, arguments: args },
    }, localContext as unknown as Record<string, unknown>));
  }

  // AsyncLocalStorage applies to every Provider seam, including Goal and Skill/MCP.
  const execute: TuiHost['execute'] = (capabilityId, args, context) => context
    ? executionContext.run(context, () => executeInternal(capabilityId, args, context))
    : executeInternal(capabilityId, args, context);

  const withBridgeTools = (
    mode: TuiRuntimeMode,
    tools: readonly RuntimeToolDefinition[],
  ) => {
    const existing = new Set(tools.map((tool) => tool.capabilityId));
    const extras: RuntimeToolDefinition[] = [];
    const bridgeTools = [
      ...(resolvedOptions.providers?.flatMap(provider => provider.toolDefinitions) ?? []),
      ...skillMcpBridge.toolDefinitions(),
      ...goalBridge.toolDefinitions,
    ];
    for (const tool of bridgeTools) {
      if (!isRuntimeToolAvailableInMode(tool, mode) || existing.has(tool.capabilityId)) continue;
      existing.add(tool.capabilityId);
      extras.push(tool);
    }
    const projected = extras.length > 0 ? [...tools, ...extras] : tools;
    if (mode === 'memory_curator') return [];
    return mode === 'project_agent' ? projected.filter(tool => evaluateProjectAgentTurn({ mode, capabilityId: tool.capabilityId }).allowed) : projected;
  };

  return {
    workspaceRoot: defaultBundle.workspaceRoot,
    // Default surface uses the mode-projected tool set, not the unfiltered
    // provider catalog. Otherwise the model would see write/shell tools even
    // when the active mode projection excludes them.
    capabilities: withBridgeTools('chat', defaultBundle.projection.tools)
      .map((tool) => tool.capabilityId),
    toolDefinitions: withBridgeTools('chat', defaultBundle.projection.tools),
    goalBridge,
    skillMcpBridge,
    getAccessLevel: () => accessLevel,
    setAccessLevel,
    capabilitiesForMode(mode) {
      const normalized = normalizeTuiRuntimeMode(mode);
      return withBridgeTools(normalized, bundleForMode(normalized).projection.tools)
        .map((tool) => tool.capabilityId);
    },
    toolDefinitionsForMode(mode) {
      const normalized = normalizeTuiRuntimeMode(mode);
      return withBridgeTools(normalized, bundleForMode(normalized).projection.tools);
    },
    execute,
    executeRead: (path, context) => execute('local.file.read', { path }, context),
    executeShell: (command, context) => execute('local.shell.exec', { command }, context),
    subscribe(listener) {
      const unsubscribes = [...bundles.values()].map((bundle) => bundle.events.subscribe(listener));
      unsubscribes.push(providerRuntime.subscribe(listener));
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
    dispose() {
      return shellSessionManager.disposeAll();
    },
  };
}
