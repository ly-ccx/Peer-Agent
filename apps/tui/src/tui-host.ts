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
  permissionOperationKey,
  createImageReadAuthority,
  resolvePermissionPrincipal,
  createBotAccessPolicyAuthority,
  createFailedClientToolResult,
  capabilityDenial,
  toolResultEvidencePreview,
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
  /** Overwritten by execute for this dispatch; callers cannot supply authority through it. */
  readonly accessPolicyStamp?: string;
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
  readonly sessionApprovals?: Set<string>;
}

function isNodeShellRiskLevel(value: unknown): value is keyof typeof NODE_SHELL_RISK_ORDER {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(NODE_SHELL_RISK_ORDER, value);
}

function automaticAccessDecision(
  accessLevel: LocalAccessLevel,
  prompt: NodeRuntimePermissionPrompt,
  botPolicy = false,
): { readonly granted: true; readonly reason: string } | null {
  if (accessLevel === 'full_local') {
    return { granted: true, reason: 'local_access_level_full' };
  }
  if (accessLevel !== 'session_local' || prompt.confirmation.kind !== 'capability-approval') {
    return null;
  }
  if (prompt.confirmation.approvalKind === 'file-write' && !botPolicy) {
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
  const sessionApprovals = resolvedOptions.sessionApprovals ?? new Set<string>();
  const approvalQueue: PendingApproval[] = [];
  let activeApproval: PendingApproval | null = null;
  let accessLevel = normalizeLocalAccessLevel(resolvedOptions.accessLevel);
  let accessEpoch = 0;
  const approvalStore = createApprovalStore({ rootDir: path.join(userDataPath, 'project-runtime') });
  const imageAuthority = createImageReadAuthority({ approvalStore });
  const botAccess = createBotAccessPolicyAuthority({ dataHome: userDataPath,
    goalPlanStore: { getPlan: (id: string) => goalBridge.store.getPlan(id), getActivePlanByConversation: (id: string) => goalBridge.store.getActivePlanByConversation(id) }, legacyAccessLevel: resolvedOptions.accessLevel });
  const accessFor = (context: TuiExecutionContext | undefined) => {
    const profile = context?.toolContext?.turnProfile as any;
    const result = botAccess.resolve({ conversationId: context?.conversationId, workspaceId: context?.project?.workspaceId,
      planId: context?.project?.planId, sessionId: context?.project?.sessionId, role: profile?.role });
    const policy = result?.ok ? result.policy : null;
    return { valid: result == null || result.ok, level: policy?.accessLevel ?? accessLevel,
      stamp: policy ? `bot:${policy.workspaceId}:${policy.conversationId}:${policy.revision}` : `global:${accessEpoch}` };
  };

  const setAccessLevel = (value: unknown): LocalAccessLevel => {
    const next = normalizeLocalAccessLevel(value);
    if (next !== accessLevel) {
      accessEpoch++;
      imageAuthority.revokeAll({ shouldRevoke: grant => {
        if (grant.policyRevision?.startsWith('bot:')) return false;
        const bot = botAccess.read(grant.workspaceId);
        return !bot.ok || bot.policy?.conversationId !== grant.conversationId;
      } });
    }
    accessLevel = next;
    try {
      resolvedOptions.persistAccessLevel?.(accessLevel);
    } catch {
      // Runtime truth still changes for this session when shared preference persistence is unavailable.
    }
    return accessLevel;
  };

  const sessionApprovalKey = (sessionId: string, prompt: NodeRuntimePermissionPrompt) => `${accessFor(executionContext.getStore()).stamp}:${permissionOperationKey({
    sessionId, capabilityId: prompt.capabilityId, args: prompt.args, workspacePath: prompt.workspacePath ?? workspaceRoot,
    conversationId: executionContext.getStore()?.conversationId,
  })}`;

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

  const requestPermissionDecision = (prompt: NodeRuntimePermissionPrompt, access: ReturnType<typeof accessFor>) => {
    const context = executionContext.getStore();
    if (context?.signal?.aborted || context?.project && !context.project.holdsLease()) {
      return Promise.resolve({ granted: false, reason: 'host_unavailable' });
    }
    if (context?.project && resolvedOptions.oneTimeApprovals?.match({
      capabilityId: prompt.capabilityId, argsDigest: digestApprovalArgs(prompt.args), at: Date.now(),
      sessionId: context.project.sessionId, workspaceId: context.project.workspaceId, policyRevision: access.stamp.startsWith('bot:') ? access.stamp : undefined,
    })) return Promise.resolve({ granted: true, reason: 'approved_once_after_resume' });
    const resolveImagePrincipal = () => {
      const principal = resolvePermissionPrincipal({ workspaceId: context?.project?.workspaceId,
        conversationId: context?.conversationId, sessionId: context?.project?.sessionId,
        planId: context?.project?.planId, goalPlanStore: goalBridge.store });
      if (principal && access.stamp.startsWith('bot:')) principal.policyRevision = access.stamp;
      return principal;
    };
    const imagePrincipal = resolveImagePrincipal();
    if (prompt.capabilityId === 'local.image.read') {
      const inherited = imageAuthority.match({ principal: imagePrincipal, scope: prompt.scope, toolCallId: context?.toolCallId });
      if (inherited) return Promise.resolve({ ...inherited, validate: () => !context?.signal?.aborted
        && (!context?.project || context.project.holdsLease()) && Boolean(imageAuthority.match({
        principal: resolveImagePrincipal(),
        scope: prompt.scope, toolCallId: context?.toolCallId })) });
    }
    const approvalKey = context
      ? sessionApprovalKey(context.project
        ? JSON.stringify([context.project.workspaceId, context.project.sessionId || context.project.planId || context.turnId, context.project.planId])
        : context.sessionId, prompt)
      : null;
    if (approvalKey && sessionApprovals.has(approvalKey)) {
      return Promise.resolve({
        granted: true,
        reason: 'approved_for_tui_session',
      });
    }

    const automaticDecision = automaticAccessDecision(access.level, prompt, access.stamp.startsWith('bot:'));
    if (automaticDecision) return Promise.resolve(automaticDecision);
    if (context?.project?.approver === false) return Promise.resolve({ granted: false, reason: 'ephemeral_no_approver' });

    if (approvalListeners.size === 0) {
      return Promise.resolve({
        granted: false,
        reason: 'tui_approval_unavailable',
      });
    }

    const requestedEpoch = accessEpoch;
    const project = context?.project;
    const store = approvalStore;
    let record: ReturnType<typeof store.append> = null;
    try {
      record = context ? store.append({
        approvalId: context.toolCallId, workspaceId: project?.workspaceId ?? null,
        conversationId: context.conversationId, streamId: context.streamId,
        sessionId: project?.sessionId, planId: project?.planId ?? null,
        capabilityId: prompt.capabilityId, summary: prompt.reason, policyRevision: access.stamp,
        riskLevel: typeof prompt.riskLevel === 'string' ? prompt.riskLevel : null, argsDigest: digestApprovalArgs(prompt.args), state: 'open',
      }) : null;
      if (context && !record) return Promise.resolve({ granted: false, reason: 'permission_unavailable' });
    } catch { return Promise.resolve({ granted: false, reason: 'permission_unavailable' }); }
    return new Promise<{ granted: boolean; reason: string; validate?: () => boolean }>((resolve) => {
      let settled = false;
      let policyWatch: ReturnType<typeof setInterval> | null = null;
      const abort = () => approval.resolve('deny');
      const approval: PendingApproval = {
        prompt,
        ...(context ? { sessionId: context.sessionId, toolCallId: context.toolCallId } : {}),
        resolve(decision) {
          if (settled) return;
          settled = true;
          if (policyWatch) clearInterval(policyWatch);
          const policyChanged = accessFor(context).stamp !== access.stamp || !accessFor(context).valid;
          context?.signal?.removeEventListener('abort', abort);
          let permitted = decision !== 'deny' && !context?.signal?.aborted && (!project || project.holdsLease())
            && accessFor(context).valid && accessFor(context).stamp === access.stamp;
          let persistenceFailed = false;
          if (record) {
            try {
              if (!store.append({ ...record, state: permitted ? 'approved' : policyChanged ? 'expired' : context?.signal?.aborted ? 'stale' : 'denied',
                ...(policyChanged ? { decisionReason: 'permission_policy_changed' } : {}),
                decidedAt: new Date().toISOString(), decidedBy: policyChanged ? 'policy' : 'local_ui' })) persistenceFailed = true;
            } catch { persistenceFailed = true; }
            if (persistenceFailed) permitted = false;
          }
          if (permitted && decision === 'allow-session' && prompt.capabilityId === 'local.image.read') {
            try { permitted = Boolean(imageAuthority.remember({ principal: imagePrincipal, scope: prompt.scope,
              record: { ...record, state: 'approved', decidedAt: new Date().toISOString(), decidedBy: 'local_ui' } })); }
            catch { permitted = false; }
          } else if (permitted && decision === 'allow-session' && approvalKey) sessionApprovals.add(approvalKey);
          if (activeApproval === approval) completeApproval();
          else { const index = approvalQueue.indexOf(approval); if (index >= 0) approvalQueue.splice(index, 1); }
          resolve({ granted: permitted, reason: permitted ? decision === 'allow-session' ? approvalKey ? 'approved_for_tui_session' : 'approved_once_without_session_context' : 'approved_once_in_tui' : persistenceFailed ? 'permission_unavailable' : policyChanged ? 'permission_policy_changed' : 'denied_in_tui',
            ...(prompt.capabilityId === 'local.image.read' ? { validate: () => (access.stamp.startsWith('bot:') || requestedEpoch === accessEpoch)
              && !context?.signal?.aborted && (!project || project.holdsLease())
              && Boolean(resolvePermissionPrincipal({ workspaceId: project?.workspaceId, conversationId: context?.conversationId,
                sessionId: project?.sessionId, planId: project?.planId, goalPlanStore: goalBridge.store }))
              && (decision !== 'allow-session' || Boolean(imageAuthority.match({ principal: imagePrincipal, scope: prompt.scope, toolCallId: context?.toolCallId }))) } : {}),
          });
        },
      };
      policyWatch = setInterval(() => { if (accessFor(context).stamp !== access.stamp || !accessFor(context).valid) approval.resolve('deny'); }, 500);
      policyWatch.unref?.();
      context?.signal?.addEventListener('abort', abort, { once: true });
      if (context?.signal?.aborted) { abort(); return; }
      approvalQueue.push(approval);
      showNextApproval();
    });
  };

  const requestPermission = async (prompt: NodeRuntimePermissionPrompt) => {
    const context = executionContext.getStore();
    const access = accessFor(context);
    if (!access.valid) return { granted: false, reason: 'access_identity_invalid' };
    const decision = await requestPermissionDecision(prompt, access);
    const valid = () => !context?.signal?.aborted && (!context?.project || context.project.holdsLease())
      && accessFor(context).valid && accessFor(context).stamp === access.stamp;
    if (decision.granted && !valid()) return { granted: false, reason: 'permission_policy_changed' };
    const previous = 'validate' in decision ? decision.validate : null;
    return { ...decision, policyRevision: access.stamp, validate: () => valid() && (typeof previous !== 'function' || previous()) };
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
      git: { artifactRoot: path.join(userDataPath, 'artifacts') },
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
    if (!accessFor(context).valid) return 'access_identity_invalid';
    if (context?.accessPolicyStamp && context.accessPolicyStamp !== accessFor(context).stamp) return 'permission_policy_changed';
    const modeGate = evaluateProjectAgentTurn({ mode: context?.mode, role: context?.toolContext?.turnRole ?? (context?.toolContext?.turnProfile as any)?.role, capabilityId });
    if (!modeGate.allowed) return modeGate.reason ?? 'project_agent_capability_denied';
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
      const bodyPreview = toolResultEvidencePreview(execution);
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
    if (blocked) {
      const result = createFailedClientToolResult({ call: { toolCallId, capabilityId }, locale: 'zh-CN', reason: blocked, status: 'denied' });
      if (['read_only', 'project_agent_capability_denied', 'capability_not_projected'].includes(blocked)) {
        result.outputPreview = { ...result.outputPreview, ...capabilityDenial({ reason: blocked, capabilityId,
          toolName: undefined, locale: 'zh-CN', stage: blocked === 'capability_not_projected' ? 'projection' : 'role' }) };
      }
      return { result } as RuntimeSdkProviderExecution;
    }

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
      toolContext: context?.toolContext,
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
  const execute: TuiHost['execute'] = (capabilityId, args, context) => {
    const bound = context ? { ...context, accessPolicyStamp: accessFor(context).stamp } : undefined;
    return bound ? executionContext.run(bound, () => executeInternal(capabilityId, args, bound))
      : executeInternal(capabilityId, args, bound);
  };

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
        if (!resolvedOptions.sessionApprovals) sessionApprovals.clear();
        while (activeApproval) activeApproval.resolve('deny');
      };
    },
    dispose() {
      while (activeApproval) activeApproval.resolve('deny');
      botAccess.close();
      return shellSessionManager.disposeAll();
    },
  };
}
