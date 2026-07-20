import type { ModelMessage, ModelToolCall, ModelUsage } from '@peer-agent/runtime-node';
import {
  createRuntimePipeline,
  createRuntimeSessionController,
  type RuntimePipelineModelAdapter,
  type RuntimePipelineToolCall,
  type RuntimeGoalTaskExecutionContext,
  type RuntimeGoalTaskExecutionResult,
  type RuntimeGoalTaskInput,
  type RuntimeSessionController,
  type RuntimeSessionSnapshot,
  type RuntimeSessionTurnHandle,
  type RuntimeSdkProviderExecution,
} from '@peer-agent/runtime-sdk';

import { compactModelMessagesStructurally } from './context-compact.ts';
import type { PlanCoordinator, PlanSnapshot } from './plan-mode.ts';
import { parseRuntimePlanText } from './plan-mode.ts';
import type { TuiHost } from './tui-host.ts';
import { normalizeTuiMode, type TuiMode } from './tui-mode.ts';
import {
  createToolPresentation,
  formatToolResultSummary,
  toolPresentationContent,
  type ToolPresentation,
} from './tool-result-summary.ts';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';
export type ChatRunStatus = 'idle' | 'running' | 'cancelling';

export interface ChatCompactMeta {
  readonly phase: 'progress' | 'done';
  readonly percent?: number;
  readonly beforeCount?: number;
  readonly afterCount?: number;
  readonly summarizedCount?: number;
}

export interface ChatMessageImage {
  readonly url: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly images?: readonly ChatMessageImage[];
  readonly pending?: boolean;
  readonly usage?: ModelUsage;
  /** Structured tool presentation for hierarchical TUI rendering. */
  readonly tool?: ToolPresentation;
  /** Compact progress / separator metadata for system messages. */
  readonly compact?: ChatCompactMeta;
}

export interface ChatSnapshot {
  readonly status: ChatRunStatus;
  readonly mode: TuiMode;
  readonly activeTurnMode?: TuiMode;
  readonly messages: readonly ChatMessage[];
  readonly session?: RuntimeSessionSnapshot;
  readonly plan?: PlanSnapshot;
  readonly usage?: ModelUsage;
  readonly error?: string;
}

export interface ChatModelToolCall extends RuntimePipelineToolCall {
  readonly capabilityId: string;
  readonly arguments: Record<string, unknown>;
}

export interface ChatModelInput {
  readonly content: string;
  readonly images?: readonly ChatMessageImage[];
  readonly history: readonly ChatMessage[];
  readonly modelMessages: readonly ModelMessage[];
  readonly turnId: string;
  readonly turnIndex: number;
}

export interface ChatModelState {
  readonly messages: readonly ChatMessage[];
  readonly modelMessages: readonly ModelMessage[];
  readonly toolExecutions: readonly RuntimeSdkProviderExecution[];
  readonly pendingToolCalls?: readonly ModelToolCall[];
  readonly usage?: ModelUsage;
}

export interface ChatModelPort extends RuntimePipelineModelAdapter<
  ChatModelInput,
  ChatModelState,
  ChatModelToolCall,
  RuntimeSdkProviderExecution,
  string
> {}

export interface ChatRestoreInput {
  readonly mode: TuiMode;
  readonly messages: readonly ChatMessage[];
  readonly usage?: ModelUsage;
}

export interface ChatCompactResult {
  readonly ok: boolean;
  readonly compacted: boolean;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly summarizedCount: number;
  readonly notice: string;
}

export interface ChatController {
  getSnapshot(): ChatSnapshot;
  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void;
  setMode(mode: TuiMode): boolean;
  restore(input: ChatRestoreInput): boolean;
  clear(): boolean;
  /** Compress modelMessages with a structural summary; UI transcript keeps a progress then separator. Idle only. */
  compact(): Promise<ChatCompactResult>;
  send(content: string, options?: { readonly images?: readonly ChatMessageImage[] }): Promise<void>;
  executeGoalTask(
    task: RuntimeGoalTaskInput,
    context: RuntimeGoalTaskExecutionContext,
  ): Promise<RuntimeGoalTaskExecutionResult>;
  cancel(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function renderCompactProgressBar(percent: number, width = 16): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

export function createChatController(options: {
  readonly host: TuiHost;
  readonly model: ChatModelPort;
  readonly sessionId?: string;
  readonly conversationId?: string;
  readonly initialMode?: TuiMode;
  readonly sessionController?: RuntimeSessionController;
  readonly planCoordinator?: PlanCoordinator;
}): ChatController {
  const listeners = new Set<(snapshot: ChatSnapshot) => void>();
  const sessionId = options.sessionId ?? 'tui-chat';
  const conversationId = options.conversationId ?? sessionId;
  const initialMode = normalizeTuiMode(options.initialMode);
  let snapshot: ChatSnapshot = { status: 'idle', mode: initialMode, messages: [] };
  let activeTurn: RuntimeSessionTurnHandle | null = null;
  let conversationModelMessages: readonly ModelMessage[] = [];
  let executionEvidenceIds: string[] = [];
  let sequence = 0;
  const sessions = options.sessionController ?? createRuntimeSessionController();

  const publish = (next: ChatSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  options.planCoordinator?.subscribe((plan) => {
    if (snapshot.plan === plan) return;
    publish({ ...snapshot, plan: plan ?? undefined });
  });

  const pipeline = createRuntimePipeline<
    ChatModelInput,
    ChatModelState,
    ChatModelToolCall,
    RuntimeSdkProviderExecution,
    string
  >({
    model: options.model,
    tools: {
      async execute(call, context) {
        const execution = await options.host.execute(call.capabilityId, call.arguments, {
          sessionId: context.run.sessionId,
          ...(context.run.conversationId
            ? { conversationId: context.run.conversationId }
            : {}),
          ...(context.run.streamId ? { streamId: context.run.streamId } : {}),
          mode: normalizeTuiMode(context.run.mode),
          turnId: context.run.input.turnId,
          turnIndex: context.run.input.turnIndex,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const evidence = execution.result.evidence;
        const evidenceId = evidence && typeof evidence === 'object' && 'evidenceId' in evidence
          ? String(evidence.evidenceId)
          : '';
        if (evidenceId) executionEvidenceIds = [...executionEvidenceIds, evidenceId];
        const tool = createToolPresentation({
          capabilityId: call.capabilityId,
          arguments: call.arguments,
          status: execution.result.status,
          outputPreview: execution.result.outputPreview,
          errorMessage: execution.result.error && typeof execution.result.error === 'object'
            && 'message' in execution.result.error
            ? String((execution.result.error as { message?: unknown }).message ?? '')
            : null,
        });
        publish({
          ...snapshot,
          messages: [
            ...snapshot.messages,
            {
              id: `tool-${++sequence}`,
              role: 'tool',
              content: toolPresentationContent(tool),
              tool,
            },
          ],
        });
        return { call, result: execution };
      },
    },
    events: {
      emit(event) {
        if (event.type === 'message.delta') {
          const messages = [...snapshot.messages];
          const last = messages.at(-1);
          if (last?.role === 'assistant' && last.pending) {
            messages[messages.length - 1] = { ...last, content: last.content + event.content };
          } else {
            messages.push({
              id: `assistant-${++sequence}`,
              role: 'assistant',
              content: event.content,
              pending: true,
            });
          }
          publish({ ...snapshot, messages });
        }
        return null;
      },
    },
  });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    setMode(mode) {
      const nextMode = normalizeTuiMode(mode, snapshot.mode);
      if (nextMode === snapshot.mode) return true;
      publish({ ...snapshot, mode: nextMode });
      return true;
    },
    restore(input) {
      if (activeTurn || snapshot.status !== 'idle') return false;
      const messages = input.messages
        .filter((message) => !message.pending)
        .map((message) => ({ ...message, pending: undefined }));
      conversationModelMessages = messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
      executionEvidenceIds = [];
      sequence = messages.length;
      publish({
        status: 'idle',
        mode: normalizeTuiMode(input.mode),
        messages,
        usage: input.usage,
      });
      return true;
    },
    async send(content, options) {
      const trimmed = content.trim();
      const images = options?.images?.filter((image) => Boolean(image.url)) ?? [];
      if ((!trimmed && images.length === 0) || activeTurn) return;

      const existingSession = sessions.get(sessionId);
      activeTurn = existingSession
        ? sessions.resume({ sessionId, streamId: `${sessionId}:stream:${existingSession.nextTurnIndex}` })
        : sessions.start({
            sessionId,
            conversationId,
            streamId: `${sessionId}:stream:0`,
          });
      const turn = activeTurn;
      const turnMode = snapshot.mode;
      const history = snapshot.messages.filter(
        (message) => !message.pending && message.role !== 'system',
      );
      // Keep system separators in the UI transcript while excluding them from turn history.
      const uiMessages = snapshot.messages.filter((message) => !message.pending);
      const userContent = trimmed
        || (images.length > 0 ? `[image${images.length > 1 ? 's' : ''}]` : '');
      publish({
        status: 'running',
        mode: turnMode,
        activeTurnMode: turnMode,
        session: sessions.get(sessionId) ?? undefined,
        messages: [
          ...uiMessages,
          {
            id: `user-${++sequence}`,
            role: 'user',
            content: userContent,
            ...(images.length > 0 ? { images } : {}),
          },
        ],
      });

      try {
        const result = await pipeline.run(
          {
            sessionId: turn.sessionId,
            ...(turn.conversationId ? { conversationId: turn.conversationId } : {}),
            ...(turn.streamId ? { streamId: turn.streamId } : {}),
            mode: turnMode,
            input: {
              content: userContent,
              ...(images.length > 0 ? { images } : {}),
              history,
              modelMessages: conversationModelMessages,
              turnId: turn.turnId,
              turnIndex: turn.turnIndex,
            },
          },
          { signal: turn.signal },
        );
        if (result.state) conversationModelMessages = result.state.modelMessages;

        if (result.status === 'cancelled') turn.cancel(result.reason);
        else if (result.status === 'exhausted') turn.fail('turn_limit_exhausted');
        else turn.complete();

        if (turnMode === 'plan' && result.status === 'completed' && result.output) {
          const plan = parseRuntimePlanText(result.output);
          if (plan) options.planCoordinator?.publish(plan);
        }

        publish({
          status: 'idle',
          mode: snapshot.mode,
          session: sessions.get(sessionId) ?? undefined,
          plan: options.planCoordinator?.getSnapshot() ?? undefined,
          usage: result.state?.usage,
          messages: snapshot.messages.map((message) =>
            message.pending ? { ...message, pending: false } : message,
          ),
          error: result.status === 'exhausted' ? 'The model exhausted its turn limit.' : undefined,
        });
      } catch (error) {
        const wasCancelled = turn.signal.aborted;
        if (wasCancelled) turn.cancel(errorMessage(error));
        else turn.fail(errorMessage(error));
        publish({
          status: 'idle',
          mode: snapshot.mode,
          session: sessions.get(sessionId) ?? undefined,
          messages: snapshot.messages.map((message) =>
            message.pending ? { ...message, pending: false } : message,
          ),
          error: wasCancelled ? undefined : errorMessage(error),
        });
      } finally {
        if (activeTurn === turn) activeTurn = null;
      }
    },
    clear() {
      if (activeTurn) return false;
      conversationModelMessages = [];
      executionEvidenceIds = [];
      publish({ status: 'idle', mode: snapshot.mode, messages: [] });
      return true;
    },
    async compact() {
      if (activeTurn || snapshot.status !== 'idle') {
        return {
          ok: false,
          compacted: false,
          beforeCount: conversationModelMessages.length,
          afterCount: conversationModelMessages.length,
          summarizedCount: 0,
          notice: 'Compact is available only while idle',
        };
      }

      const beforeCount = conversationModelMessages.length;
      if (beforeCount === 0) {
        return {
          ok: true,
          compacted: false,
          beforeCount: 0,
          afterCount: 0,
          summarizedCount: 0,
          notice: 'Nothing to compact',
        };
      }

      const progressId = `compact-${++sequence}`;
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const publishProgress = (percent: number) => {
        const content = `Compacting context  ${renderCompactProgressBar(percent)}  ${percent}%`;
        const progressMessage: ChatMessage = {
          id: progressId,
          role: 'system',
          content,
          pending: true,
          compact: { phase: 'progress', percent },
        };
        const without = snapshot.messages.filter((message) => message.id !== progressId);
        publish({
          status: 'idle',
          mode: snapshot.mode,
          session: snapshot.session,
          messages: [...without, progressMessage],
          plan: snapshot.plan,
          usage: snapshot.usage,
          error: undefined,
        });
      };

      publishProgress(12);
      await sleep(35);
      publishProgress(48);
      await sleep(35);
      publishProgress(78);
      await sleep(25);

      const result = compactModelMessagesStructurally(conversationModelMessages);
      if (!result.compacted) {
        const notice =
          result.reason === 'empty'
            ? 'Nothing to compact'
            : 'Context is already compact enough';
        publish({
          status: 'idle',
          mode: snapshot.mode,
          session: snapshot.session,
          messages: snapshot.messages.filter((message) => message.id !== progressId),
          plan: snapshot.plan,
          usage: snapshot.usage,
          error: undefined,
        });
        return {
          ok: true,
          compacted: false,
          beforeCount: result.beforeCount,
          afterCount: result.afterCount,
          summarizedCount: 0,
          notice,
        };
      }

      conversationModelMessages = result.messages;
      const doneContent =
        `Compacted ${result.beforeCount} → ${result.afterCount} messages` +
        ` (summarized ${result.summarizedCount})`;
      const doneMessage: ChatMessage = {
        id: progressId,
        role: 'system',
        content: doneContent,
        compact: {
          phase: 'done',
          percent: 100,
          beforeCount: result.beforeCount,
          afterCount: result.afterCount,
          summarizedCount: result.summarizedCount,
        },
      };
      // Preserve UI transcript and usage; only provider history shrinks. Progress row becomes a durable separator.
      const withoutProgress = snapshot.messages.filter((message) => message.id !== progressId);
      publish({
        status: 'idle',
        mode: snapshot.mode,
        session: snapshot.session,
        messages: [...withoutProgress, doneMessage],
        plan: snapshot.plan,
        usage: snapshot.usage,
        error: undefined,
      });

      return {
        ok: true,
        compacted: true,
        beforeCount: result.beforeCount,
        afterCount: result.afterCount,
        summarizedCount: result.summarizedCount,
        notice: `Compacted model context ${result.beforeCount} → ${result.afterCount} messages (summarized ${result.summarizedCount})`,
      };
    },
    async executeGoalTask(task, context) {
      if (activeTurn) return { status: 'blocked', reason: 'chat_turn_active' };
      const beforeMessages = snapshot.messages.length;
      const beforeEvidenceCount = executionEvidenceIds.length;
      this.setMode('goal');
      await this.send(
        `Execute only this approved goal task (${task.taskId}): ${task.title}\n` +
        `Goal ${context.goalId} from plan ${context.sourcePlanId}\n` +
        'Complete it through the existing Runtime Pipeline. Do not execute later tasks.',
      );

      if (context.signal.aborted) return { status: 'blocked', reason: 'goal_task_cancelled' };
      if (snapshot.error) return { status: 'failed', reason: snapshot.error };

      const evidenceRefs = executionEvidenceIds
        .slice(beforeEvidenceCount)
        .map((evidenceId) => `evidence://${evidenceId}`);
      if (evidenceRefs.length === 0) {
        return {
          status: 'blocked',
          reason: snapshot.messages.length > beforeMessages
            ? 'goal_task_completed_without_evidence'
            : 'goal_task_produced_no_result',
        };
      }
      return { status: 'completed', evidenceRefs };
    },
    cancel() {
      if (!activeTurn) return;
      const session = sessions.cancel(sessionId, 'cancelled_in_tui');
      publish({
        ...snapshot,
        status: 'cancelling',
        ...(session ? { session } : {}),
      });
    },
  };
}

export function createDemoChatModel(): ChatModelPort {
  return {
    initialize(input) {
      return {
        messages: [
          ...input.input.history,
          {
            id: 'input',
            role: 'user',
            content: input.input.content,
            ...(input.input.images && input.input.images.length > 0
              ? { images: input.input.images }
              : {}),
          } as ChatMessage,
        ],
        modelMessages: [
          ...input.input.modelMessages,
          {
            role: 'user',
            content: input.input.images && input.input.images.length > 0
              ? [
                  ...(input.input.content.trim()
                    ? [{ type: 'text' as const, text: input.input.content }]
                    : []),
                  ...input.input.images.map((image) => ({
                    type: 'image_url' as const,
                    image_url: { url: image.url },
                  })),
                ]
              : input.input.content,
          },
        ],
        toolExecutions: [],
      };
    },
    async runTurn(state, context) {
      if (state.toolExecutions.length === 0 && context.run.input.content.startsWith('/read ')) {
        return {
          kind: 'tool_calls',
          state,
          calls: [{
            toolCallId: `read-${context.turn}`,
            capabilityId: 'local.file.read',
            arguments: { path: context.run.input.content.slice(6).trim() },
          }],
        };
      }

      const text = state.toolExecutions.length > 0
        ? `Tool completed: ${formatToolResultSummary(
          state.toolExecutions.at(-1)?.result.outputPreview,
          'done',
        )}`
        : `Demo model: ${context.run.input.content}`;
      for (const token of text.split(/(?<=\s)/u)) {
        if (context.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        context.emit({ type: 'message.delta', streamId: context.run.streamId ?? 'tui-chat', content: token });
        await Bun.sleep(8);
      }
      return {
        kind: 'completed',
        state: {
          ...state,
          modelMessages: [...state.modelMessages, { role: 'assistant', content: text }],
        },
        output: text,
      };
    },
    applyToolResults(state, executions) {
      return {
        ...state,
        modelMessages: [
          ...state.modelMessages,
          ...executions.map((item) => ({
            role: 'tool' as const,
            toolCallId: item.call.toolCallId,
            content: formatToolResultSummary(
              item.result.result.outputPreview,
              item.result.result.status ?? 'completed',
            ),
          })),
        ],
        toolExecutions: [...state.toolExecutions, ...executions.map((item) => item.result)],
      };
    },
  };
}
