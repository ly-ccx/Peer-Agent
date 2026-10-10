import { randomUUID } from 'node:crypto';
import {
  resolveRoleRoute, readSnapshots, createExecutionScheduler, createWorkBudgetGuard,
  createFailedClientToolResult,
  createGoalPlanStore,
  loadSharedModelMetadataList,
  type ModelMessage,
} from '@peer-agent/runtime-node';
import { createRuntimePipeline, type RuntimeSdkProviderExecution, type RuntimePipelineToolExecution } from '@peer-agent/runtime-sdk';
import { collectToolEvidenceRefs, projectConversationHistory } from '@peer-agent/runtime-core';
import type { ChatModelInput, ChatModelState, ChatModelToolCall } from '../chat-controller.ts';
import type { TuiRuntimeMode } from '../tui-mode.ts';
import { createTuiRuntime, type TuiRuntime } from '../tui-runtime.ts';
import { resolvePersistedModelSelection } from '../tui-model-selection.ts';
import type { PendingApproval, TuiCapabilityProvider } from '../tui-host.ts';

export interface TuiTurnRequest {
  conversationId?: string | null;
  workspaceId?: string;
  workspacePath?: string;
  streamId?: string;
  mode?: string;
  messages?: readonly ModelMessage[];
  turnProfile?: any;
  budgetGuard?: any;
  plan?: any;
  limits?: { maxRounds: number; maxToolCalls: number };
  remainingToolCalls?: number;
  hardRemainingToolCalls?: number;
  modelProviderId?: string | null;
  signal?: AbortSignal;
  ephemeral?: boolean;
  assistantMessageId?: string;
  continuityContext?: readonly object[];
  runtimeReminders?: readonly object[];
  explorerContext?: object;
  verifierContext?: object;
  permissionPolicy?: object;
  agentProgress?: { onRound?(): void; onToolCall?(input: {tool: string; input: object}): void; onToolExecution?(execution: object): void };
  sink: { send(channel: string, payload: unknown): void; approver?: string };
}

/** Independent turn runtimes preserve model, workspace, cancellation and permission identity. */
export function createTuiTurnExecutor(options: {
  dataHome: string;
  getSettings(): any;
  holdsLease(workspaceId: string): boolean;
  resolveWorkspacePath(workspaceId: string): string;
  readMessages(conversationId: string): readonly any[];
  readMemory(workspaceId: string): readonly any[];
  memoryEnabled(workspaceId: string): boolean;
  getProviders(): readonly TuiCapabilityProvider[];
  onApproval?(approval: PendingApproval | null, streamId: string): void;
  oneTimeApprovals?: { match(input: object): boolean };
  goalPlanStore?: ReturnType<typeof createGoalPlanStore>;
  persistTurn?(input: TuiTurnRequest, output: {text: string; calls: readonly any[]; usage?: object; interrupted: boolean}): void;
  scheduler?: ReturnType<typeof createExecutionScheduler>;
  createRuntime?: typeof createTuiRuntime;
}) {
  const executionScheduler = options.scheduler ?? createExecutionScheduler();
  const active = new Map<string, { workspaceId: string; controller: AbortController; done: Promise<any> }>();
  const sessionApprovals = new Set<string>();
  const runtimeFactory = options.createRuntime ?? createTuiRuntime;
  function resolveGoalRole(input: any) {
    const settings = options.getSettings();
    const providers = loadSharedModelMetadataList({ userDataPath: options.dataHome }).map(model => ({
      id: model.entryId ?? model.credentialId, groupId: model.credentialId, model: model.model,
      providerType: model.providerId, apiKeyConfigured: model.credentialStored, supportsTools: model.supportsTools,
      supportsVision: model.supportsVision, supportsStructured: model.supportsStructured, contextWindow: model.contextWindow,
    }));
    return resolveRoleRoute({ providers, routing: settings.modelRouting, ...input });
  }
  async function execute(input: TuiTurnRequest, controller: AbortController) {
    const profile = input.turnProfile ?? {};
    const workspaceId = input.workspaceId ?? profile.workspaceId ?? '';
    if (workspaceId && !options.holdsLease(workspaceId)) return { ok: false, error: 'host_unavailable', retryable: false };
    const workspacePath = input.workspacePath || options.resolveWorkspacePath(workspaceId);
    const mode = (input.mode ?? (profile.role === 'project_agent' ? 'project_agent' : 'chat')) as TuiRuntimeMode;
    const streamId = input.streamId || randomUUID();
    const runtime: TuiRuntime = runtimeFactory({ workspaceRoot: workspacePath, userDataPath: options.dataHome,
      accessLevel: options.getSettings().localAccessLevel ?? 'restricted_local', providers: options.getProviders(), oneTimeApprovals: options.oneTimeApprovals, goalPlanStore: options.goalPlanStore, sessionApprovals });
    const selectedId = input.modelProviderId || profile.modelSelection?.modelProviderId;
    if (selectedId) {
      const selected = resolvePersistedModelSelection(runtime.modelSelection, {
        providerId: selectedId, modelId: profile.modelSelection?.modelId ?? '', reasoningEffort: profile.modelSelection?.reasoningEffort ?? 'default',
      });
      if (!selected) { await runtime.dispose(); return { ok: false, error: 'model_unavailable', retryable: false }; }
      runtime.modelSelection.setSelection(selected);
    }
    const unsubscribeApproval = runtime.host.subscribeApproval(approval => options.onApproval?.(approval, streamId));
    const calls: any[] = [];
    let toolReservations = 0, streamedText = '';
    if (profile.providerCheckpoint && (profile.providerCheckpoint.provider !== 'tui' || profile.providerCheckpoint.modelProviderId !== input.modelProviderId)) throw new Error('continuity_model_changed');
    const saved = profile.role === 'project_agent' && profile.providerCheckpoint?.provider === 'tui'
      && profile.providerCheckpoint.modelProviderId === input.modelProviderId ? profile.providerCheckpoint : null;
    const messages = saved?.messages ?? input.messages ?? projectConversationHistory(options.readMessages(input.conversationId ?? '')).messages;
    const last = messages.at(-1);
    const content = !saved && last?.role === 'user' && typeof last.content === 'string' ? last.content : '';
    const history = content ? messages.slice(0, -1) : messages;
    const useMemory = options.memoryEnabled(workspaceId);
    const toolContext: Record<string, any> = { workspaceId, workspacePath, conversationId: input.conversationId,
      mode, role: profile.role, turnProfile: profile, surface: 'tui', turnId: streamId, messages: options.readMessages(input.conversationId ?? ''),
      currentInputAnchors: (profile.context?.inputAnchors ?? []).map((row: any) => row.messageId),
      objectiveWakeIds: (profile.context?.events ?? []).filter((row: any) => row.kind === 'objective_signal' && row.workspaceId === workspaceId).map((row: any) => row.objectiveId),
      objectiveWakeEvents: (profile.context?.events ?? []).filter((row: any) => row.kind === 'objective_signal' && row.workspaceId === workspaceId),
      sessionWakeIds: (profile.context?.events ?? []).filter((row: any) => ['report_available','result_ready','session_verified'].includes(row.kind) && row.workspaceId === workspaceId).map((row: any) => row.sessionId),
      turnToolCalls: calls, quoteRefs: input.plan?.userInputs?.flatMap((row: any) => row.quoteRefs ?? []) ?? [],
    };
    const model = { ...runtime.model,
      checkpoint(state: ChatModelState, executions: readonly RuntimePipelineToolExecution<ChatModelToolCall, RuntimeSdkProviderExecution>[]) {
        input.budgetGuard?.checkpoint({ provider: 'tui', modelProviderId: input.modelProviderId, messages: state.modelMessages }, executions);
      },
      runTurn(state: ChatModelState, context: any) {
      input.budgetGuard?.beforeRequest();
      input.agentProgress?.onRound?.();
      return runtime.model.runTurn(state, context);
    } };
    const pipeline = createRuntimePipeline<ChatModelInput, ChatModelState, ChatModelToolCall, RuntimeSdkProviderExecution, string>({
      model, defaultMaxTurns: input.limits?.maxRounds ?? Number.POSITIVE_INFINITY,
      events: { emit(event) {
        if (event.type === 'message.delta') { streamedText += event.content; input.sink.send('chat:stream:delta', { streamId, content: event.content }); }
        return null;
      } },
      tools: { notExecuted: (call, reason) => ({ call, result: { result: createFailedClientToolResult({ call, locale: 'zh-CN', reason, status: 'denied' }) }, terminal: true, terminalReason: reason }),
        async execute(call, context) {
        try { input.budgetGuard?.beforeTool(call); } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { call, result: { result: createFailedClientToolResult({ call, locale: 'zh-CN', reason, status: 'denied' }) }, terminal: true, terminalReason: reason };
        }
        const budget = profile.role === 'project_agent' ? input.hardRemainingToolCalls ?? Infinity : input.remainingToolCalls ?? input.limits?.maxToolCalls ?? Infinity;
        const ordinal = toolReservations++;
        if (ordinal >= budget) return { call, result: { result: createFailedClientToolResult({
          call, locale: 'zh-CN', reason: 'project_agent_tool_limit', status: 'denied',
        }) }, terminal: true, terminalReason: 'project_agent_tool_limit' };
        const toolName=call.name ?? runtime.host.toolDefinitionsForMode?.(mode).find(tool=>tool.capabilityId===call.capabilityId)?.name ?? '';
        input.agentProgress?.onToolCall?.({tool: toolName, input: call.arguments});
        input.sink.send('chat:stream:tool-call', { streamId, toolCallId: call.toolCallId, tool: toolName, args: call.arguments });
        const execution = await runtime.host.execute(call.capabilityId, call.arguments, {
          sessionId: context.run.sessionId, conversationId: input.conversationId ?? undefined,
          streamId, turnId: streamId, turnIndex: context.turn, toolCallId: call.toolCallId, mode, signal: controller.signal,
          toolContext: { ...toolContext, toolCallOrdinal: ordinal },
          ...(workspaceId ? { project: { workspaceId, sessionId: profile.sessionId, planId: profile.planId,
            readOnly: profile.context?.workSessionOrigin?.readOnly === true || input.plan?.delegationOrigin?.readOnly === true,
            approver: !input.ephemeral || profile.role === 'project_agent', holdsLease: () => options.holdsLease(workspaceId) } } : {}),
        });
        input.agentProgress?.onToolExecution?.({ call: { ...call, capabilityId: call.capabilityId },
          grant: execution.grant ?? execution.result.permissionGrant, result: execution.result });
        const legacy = (execution.result.outputPreview as any)?.legacyResult;
        let result: any = execution.result.output ?? legacy?.output ?? execution.result;
        if (typeof result === 'string') { try { result = JSON.parse(result); } catch { /* Text remains factual output. */ } }
        calls.push({ toolCallId: call.toolCallId, execution, name: toolName, input: call.arguments, result });
        input.sink.send('chat:stream:tool-result', { streamId, toolCallId: call.toolCallId,
          result: JSON.stringify(execution.result), evidenceRefs: collectToolEvidenceRefs({toolCallId:call.toolCallId, execution}) });
        const control = (execution.result as any).control ?? (execution.result.outputPreview as any)?.control
          ?? (execution.result.output as any)?.control ?? (execution.result.metadata as any)?.control;
        const requestUserInput = control?.requestUserInput || control?.kind === 'request_user_input' || control?.reason === 'request_user_input';
        return { call, result: execution, ...(control?.terminal === true || requestUserInput
          ? {terminal: true, terminalReason: requestUserInput ? 'requested_user_input' : control.reason} : {}) };
      } },
    });
    try {
      const result = await pipeline.run({ sessionId: `tui:${input.conversationId || streamId}`, conversationId: input.conversationId ?? undefined,
        streamId, mode, ...(profile.role === 'project_agent' ? {
          maxToolCalls: input.hardRemainingToolCalls, sliceToolCalls: input.remainingToolCalls ?? input.limits?.maxToolCalls,
          yieldAtTurnLimit: true, maxToolBatchCalls: 32,
        } : {}), input: { content, omitCurrentUser: !content, history: [], modelMessages: history, turnId: streamId, turnIndex: 0,
          systemContextInput: { role: profile.role, workspaceId, sessionId: profile.sessionId, planId: profile.planId,
            turnContext: profile.context, runtimeReminders: input.runtimeReminders, continuityContext: input.continuityContext,
            ...(profile.role === 'project_agent' && useMemory ? { projectMemory: options.readMemory(workspaceId) } : {}),
            ...(profile.role === 'work_session' ? { workSessionExecution: { phase: input.plan?.delegationOrigin?.phase }, workSessionOrigin: { ...profile.context?.workSessionOrigin,
              readOnly: input.plan?.delegationOrigin?.readOnly === true,
              summary: input.plan?.goal,
              snapshotItems: useMemory && profile.memorySnapshotId ? (readSnapshots(workspaceId, {rootDir: options.dataHome}).find((snapshot: any) => snapshot.snapshotId === profile.memorySnapshotId) as any)?.items ?? [] : [] } } : {}),
            explorerContext: input.explorerContext, verifierContext: input.verifierContext,
          },
        } }, { signal: controller.signal });
      const requestedUserInput = result.reason === 'requested_user_input';
      const replied = result.status === 'stopped' && result.reason === 'project_agent_reply';
      const ok = result.status === 'completed' || result.status === 'yielded' || requestedUserInput || replied;
      const text = !ok && streamedText ? streamedText : result.output ?? '';
      input.sink.send(ok ? 'chat:stream:done' : 'chat:stream:error', { streamId, error: result.reason });
      if (!input.ephemeral) options.persistTurn?.(input, { text, calls, usage: result.state?.usage,
        interrupted: !ok });
      return { ok, text, toolCalls: calls, toolCallCount: calls.length,
        ...(result.status === 'yielded' ? { turnEnd: 'yielded', providerCheckpoint: { provider: 'tui', modelProviderId: input.modelProviderId, messages: result.state?.modelMessages } } : {}),
        ...(requestedUserInput ? { requestedUserInput: true } : {}),
        continued: result.status === 'exhausted', terminalStatus: controller.signal.aborted ? 'aborted' : ok ? 'completed' : 'error',
        usage: result.state?.usage, ...(ok ? {} : { error: result.reason || result.status, failureReason: result.reason || result.status, retryable: false }) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!input.ephemeral) options.persistTurn?.(input, { text: streamedText, calls, interrupted: true });
      input.sink.send('chat:stream:error', { streamId, error: message });
      return { ok: false, error: message, failureReason: message, retryable: false, terminalStatus: controller.signal.aborted ? 'aborted' : 'error', toolCalls: calls };
    } finally { unsubscribeApproval(); await runtime.dispose(); }
  }
  function runTurn(input: TuiTurnRequest): Promise<any> {
    const controller = new AbortController(), key = randomUUID();
    const abort = () => controller.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const done = executionScheduler.withTurn({ planId: input.turnProfile?.planId, signal: controller.signal,
      priority: input.plan?.kind === 'user' ? 'high' : ['memory_curator', 'objective_probe'].includes(input.turnProfile?.role) ? 'low' : undefined,
    }, async (signal: AbortSignal) => {
      const cancel = () => controller.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      const budgetGuard = createWorkBudgetGuard(input.turnProfile);
      let outcome: any;
      try { outcome = await execute({ ...input, budgetGuard, signal }, controller); return outcome; }
      finally { budgetGuard?.finish(outcome?.usage); signal.removeEventListener('abort', cancel); }
    }).finally(() => {
      input.signal?.removeEventListener('abort', abort); active.delete(key);
    });
    active.set(key, { workspaceId: input.workspaceId ?? input.turnProfile?.workspaceId ?? '', controller, done });
    return done;
  }
  return { runTurn, resolveGoalRole, executionScheduler,
    async stop(workspaceId?: string) {
      const turns = [...active.values()].filter(turn => !workspaceId || turn.workspaceId === workspaceId);
      turns.forEach(turn => turn.controller.abort());
      await Promise.allSettled(turns.map(turn => turn.done));
      sessionApprovals.clear();
    },
  };
}
