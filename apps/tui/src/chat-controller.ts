import type { ModelMessage, ModelToolCall, ModelUsage } from '@peer-agent/runtime-node';
import {
  COMPACTION_PROGRESS_CONFIG,
  compactMessagesWithSummaryStrategy,
  createContextProjectionLifecycle,
  formatCompactionMessagesForSummary,
  microcompactMessagesForContext,
  type CompactionMethod,
  type ContextProjectionLifecycle,
} from '@peer-agent/runtime-core';
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

import {
  buildHandoffContent,
  buildStructuralSummary,
  TUI_COMPACT_KEEP_RECENT,
} from './context-compact.ts';
import { computeContextPressure, estimateTokensFromMessages } from './context-pressure.ts';
import {
  GOAL_CAPABILITY_IDS,
  normalizeExplorerRequest,
  type TuiExplorerRequest,
} from './goal-bridge.ts';
import {
  createTuiGoalWorkerAdapter,
  type TuiGoalWorkerAdapter,
} from './goal-worker-adapter.ts';
import type { PlanCoordinator, PlanSnapshot } from './plan-mode.ts';
import { parseRuntimePlanText } from './plan-mode.ts';
import type { TuiHost } from './tui-host.ts';
import { normalizeTuiMode, normalizeTuiRuntimeMode, type TuiMode } from './tui-mode.ts';
import {
  createToolPresentation,
  formatToolResultSummary,
  type ToolPresentation,
} from './tool-result-summary.ts';

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system';
export type ChatRunStatus = 'idle' | 'running' | 'cancelling' | 'compacting';

const STREAM_BUFFER_FLUSH_MS = 32;

export interface ChatCompactMeta {
  readonly phase: 'progress' | 'done';
  readonly percent?: number;
  readonly beforeCount?: number;
  readonly afterCount?: number;
  readonly summarizedCount?: number;
  readonly beforeTokens?: number;
  readonly afterTokens?: number;
  /** Cumulative summary admitted through System Context after this boundary. */
  readonly summary?: string;
  /** Shared handoff content persisted on the `_compaction` marker. */
  readonly handoffContent?: string;
  /** Shared Desktop/CLI summary cascade method used for this boundary. */
  readonly method?: CompactionMethod;
  /** Number of complete user turns retained after the shared boundary. */
  readonly retainedUserCount?: number;
}

export interface ChatMessageImage {
  readonly url: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
}

/** Ordered assistant timeline (Desktop-aligned). */
export type AssistantSegment =
  | { readonly type: 'thinking'; readonly content: string }
  | { readonly type: 'tool-call'; readonly tool: ToolPresentation }
  | { readonly type: 'text'; readonly content: string };

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly images?: readonly ChatMessageImage[];
  readonly pending?: boolean;
  /**
   * Streaming reasoning/thinking text (compatibility aggregate).
   * Prefer `segments` for ordered thinking/tool interleaving.
   */
  readonly thinkingContent?: string;
  readonly usage?: ModelUsage;
  /**
   * Tool presentations attached to the current assistant turn.
   * Desktop-compatible: multiple tool-calls share one assistant message.
   * Derived from `segments` when the timeline is present.
   */
  readonly tools?: readonly ToolPresentation[];
  /**
   * @deprecated Prefer `tools`. Kept for restore/compat of older single-tool rows.
   */
  readonly tool?: ToolPresentation;
  /**
   * Event-order timeline: thinking → tool-call → thinking → tool-call → text.
   * When present, TUI renders this order instead of fixed thinking-then-tools.
   */
  readonly segments?: readonly AssistantSegment[];
  /** Stream/provider failure interrupted this assistant message after partial progress. */
  readonly interrupted?: boolean;
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
  readonly requestProjection?: ChatModelState['requestProjection'];
  /** Estimated input tokens for the next final provider request. */
  readonly nextRequestInputTokens?: number;
  /** Independent conservative pressure used only to trigger automatic compaction. */
  readonly compactionPressureTokens?: number;
  readonly error?: string;
}

export interface ChatModelToolCall extends RuntimePipelineToolCall {
  readonly capabilityId: string;
  readonly arguments: Record<string, unknown>;
}

export interface ChatSystemContextBlock {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly layer?: string;
  readonly trust?: string;
}

export interface ChatModelInput {
  readonly content: string;
  readonly images?: readonly ChatMessageImage[];
  readonly history: readonly ChatMessage[];
  readonly modelMessages: readonly ModelMessage[];
  /** Last provider-observed usage, carried into the next request accounting epoch. */
  readonly usage?: ModelUsage;
  readonly systemContextBlocks?: readonly ChatSystemContextBlock[];
  readonly turnId: string;
  readonly turnIndex: number;
}

export interface ChatModelState {
  readonly messages: readonly ChatMessage[];
  readonly modelMessages: readonly ModelMessage[];
  readonly toolExecutions: readonly RuntimeSdkProviderExecution[];
  /** 会话 id(initialize 时从 run 写入):供工具结果材料化按会话归档 artifact。 */
  readonly conversationId?: string;
  readonly pendingToolCalls?: readonly ModelToolCall[];
  readonly usage?: ModelUsage;
  readonly requestProjection?: {
    readonly nextRequestInputTokens: number;
    readonly contextWindow: number | null;
    readonly model: string;
  };
  /**
   * turn 内自动压缩记录(21 号文档 13.2 安全边界:provider 请求前 preflight /
   * PTL emergency)。controller 在 turn 结束后据此更新连续性上下文、发布压缩分隔消息并
   * 经 persistence 写入共享 `_compaction` marker。
   */
  readonly midTurnCompactions?: readonly MidTurnCompaction[];
}

/** turn 内自动压缩记录(优先 LLM 摘要,失败回退 structural;与 Desktop mid-turn 对齐)。 */
export interface MidTurnCompaction {
  readonly reason: 'preflight' | 'emergency';
  readonly method: CompactionMethod;
  readonly beforeCount: number;
  readonly afterCount: number;
  readonly summarizedCount: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly summary: string;
  readonly handoffContent: string;
  readonly retainedUserCount: number;
}

export interface ChatModelPort extends RuntimePipelineModelAdapter<
  ChatModelInput,
  ChatModelState,
  ChatModelToolCall,
  RuntimeSdkProviderExecution,
  string
> {
  /** Project the exact System Context messages that the next provider request will send. */
  projectSystemMessages?(input: {
    readonly mode: TuiMode;
    readonly conversationId?: string;
    readonly systemContextBlocks?: readonly ChatSystemContextBlock[];
  }): readonly ModelMessage[];
  summarizeCompaction?(input: {
    readonly messages: readonly ModelMessage[];
    readonly formattedHistory: string;
    readonly onProgress?: (percent: number) => void;
  }): Promise<string>;
}

export interface ChatRestoreInput {
  readonly mode: TuiMode;
  /** Complete UI transcript, including historical compaction markers. */
  readonly messages: readonly ChatMessage[];
  /** Active provider history after the latest shared compaction boundary. */
  readonly modelMessages?: readonly ModelMessage[];
  /** Latest cumulative compaction summary, admitted through System Context. */
  readonly continuityContext?: string;
  readonly usage?: ModelUsage;
  readonly nextRequestInputTokens?: number;
  readonly requestProjection?: ChatModelState['requestProjection'];
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
  send(content: string, options?: {
    readonly images?: readonly ChatMessageImage[];
    /** Goal Runner ticks: feed the model without rendering a user bubble (Desktop parity). */
    readonly hideFromUi?: boolean;
  }): Promise<void>;
  runGoalTurn(content: string): Promise<{
    readonly continued: boolean;
    readonly explorers: readonly TuiExplorerRequest[];
    readonly toolCallCount: number;
    readonly failed?: boolean;
    readonly failureReason?: string;
    readonly terminalStatus?: 'error' | 'aborted' | string;
  }>;
  runExplorer(input: Parameters<TuiGoalWorkerAdapter['runExplorer']>[0]): ReturnType<TuiGoalWorkerAdapter['runExplorer']>;
  runVerifier(input: Parameters<TuiGoalWorkerAdapter['runVerifier']>[0]): ReturnType<TuiGoalWorkerAdapter['runVerifier']>;
  executeGoalTask(
    task: RuntimeGoalTaskInput,
    context: RuntimeGoalTaskExecutionContext,
  ): Promise<RuntimeGoalTaskExecutionResult>;
  cancel(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolKey(tool: ToolPresentation): string {
  return tool.toolCallId?.trim() || `${tool.capabilityId}:${tool.argumentSummary}`;
}

function messageTools(message: ChatMessage | undefined): ToolPresentation[] {
  if (!message) return [];
  if (message.tools && message.tools.length > 0) return [...message.tools];
  if (message.segments && message.segments.length > 0) {
    const fromSegments = message.segments
      .filter((segment): segment is Extract<AssistantSegment, { type: 'tool-call' }> => segment.type === 'tool-call')
      .map((segment) => segment.tool);
    if (fromSegments.length > 0) return fromSegments;
  }
  if (message.tool) return [message.tool];
  return [];
}

function thinkingContentFromSegments(segments: readonly AssistantSegment[] | undefined): string | undefined {
  if (!segments || segments.length === 0) return undefined;
  const parts = segments
    .filter((segment): segment is Extract<AssistantSegment, { type: 'thinking' }> => segment.type === 'thinking')
    .map((segment) => segment.content)
    .filter((content) => content.length > 0);
  if (parts.length === 0) return undefined;
  return parts.join('');
}

function textContentFromSegments(segments: readonly AssistantSegment[] | undefined): string {
  if (!segments || segments.length === 0) return '';
  return segments
    .filter((segment): segment is Extract<AssistantSegment, { type: 'text' }> => segment.type === 'text')
    .map((segment) => segment.content)
    .join('');
}

function withDerivedAssistantFields(message: ChatMessage, segments: readonly AssistantSegment[]): ChatMessage {
  const tools = segments
    .filter((segment): segment is Extract<AssistantSegment, { type: 'tool-call' }> => segment.type === 'tool-call')
    .map((segment) => segment.tool);
  const thinkingContent = thinkingContentFromSegments(segments);
  const textContent = textContentFromSegments(segments);
  return {
    ...message,
    segments,
    // Keep any non-segment content only when no text segments yet (compat).
    content: textContent || (segments.some((s) => s.type === 'text') ? '' : message.content),
    ...(thinkingContent !== undefined ? { thinkingContent } : { thinkingContent: undefined }),
    ...(tools.length > 0
      ? { tools, tool: tools[tools.length - 1] }
      : { tools: undefined, tool: undefined }),
  };
}

function restoredMessageSequence(messages: readonly ChatMessage[]): number {
  return messages.reduce((highest, message) => {
    const match = /^(?:user|assistant|compact)-(\d+)$/.exec(message.id);
    if (!match) return highest;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? Math.max(highest, value) : highest;
  }, messages.length);
}

/**
 * Upsert a tool presentation onto the current assistant turn.
 * Creates a pending assistant placeholder when none exists yet (tool-first turn).
 * Appends a new tool-call segment in event order so thinking/tool can interleave.
 */
function upsertAssistantTool(
  messages: readonly ChatMessage[],
  tool: ToolPresentation,
  nextSequence: () => number,
): ChatMessage[] {
  const next = [...messages];
  const key = toolKey(tool);
  let targetIndex = -1;
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const message = next[i];
    if (!message) continue;
    if (message.role === 'assistant' && message.pending) {
      targetIndex = i;
      break;
    }
    if (message.role === 'assistant' || message.role === 'user' || message.role === 'system') {
      break;
    }
  }
  // Never attach tools to a completed previous assistant turn.
  // If there is no pending assistant yet, open a new one for this tool batch.
  if (targetIndex < 0) {
    const segments: AssistantSegment[] = [{ type: 'tool-call', tool }];
    next.push(withDerivedAssistantFields({
      id: `assistant-${nextSequence()}`,
      role: 'assistant',
      content: '',
      pending: true,
    }, segments));
    return next;
  }

  const target = next[targetIndex]!;
  const existingSegments = [...(target.segments ?? [])];
  const segmentIndex = existingSegments.findIndex(
    (segment) => segment.type === 'tool-call' && toolKey(segment.tool) === key,
  );
  if (segmentIndex >= 0) {
    existingSegments[segmentIndex] = { type: 'tool-call', tool };
  } else {
    existingSegments.push({ type: 'tool-call', tool });
  }
  next[targetIndex] = withDerivedAssistantFields(target, existingSegments);
  return next;
}

/** Clear historical interrupted markers when the conversation continues. */
export function clearInterruptedMarkers(
  messages: readonly ChatMessage[],
): { messages: ChatMessage[]; changed: boolean } {
  let changed = false;
  const next = messages.map((message) => {
    if (message.interrupted !== true) return message;
    changed = true;
    const { interrupted: _removed, ...rest } = message;
    return rest;
  });
  return { messages: changed ? next : (messages as ChatMessage[]), changed };
}

/** Drop empty thinking placeholders; keep messages that already received content. */
function finalizePendingMessages(
  messages: readonly ChatMessage[],
  options?: { readonly interrupted?: boolean; readonly error?: string },
): ChatMessage[] {
  const interrupted = options?.interrupted === true;
  const errorNote = options?.error?.trim();
  // Prefer the latest assistant (even empty pending placeholder) as the recovery anchor.
  let recoveryIndex = -1;
  if (interrupted) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'assistant') {
        recoveryIndex = i;
        break;
      }
    }
  }
  return messages
    .map((message, index) => {
      if (!message.pending && !(interrupted && index === recoveryIndex)) return message;
      if (message.pending) {
        // Empty placeholder that never received text/thinking/tool progress:
        // keep only when this is the recovery anchor for a failed stream.
        const hasProgress = Boolean(
          message.content
          || message.thinkingContent
          || message.tool
          || (message.tools && message.tools.length > 0)
          || (message.segments && message.segments.length > 0),
        );
        if (!hasProgress && index !== recoveryIndex) return null;
      }
      const next: ChatMessage = message.pending
        ? { ...message, pending: false }
        : message;
      if (!interrupted || message.role !== 'assistant' || index !== recoveryIndex) return next;
      // Preserve partial assistant progress and mark the turn as recoverable.
      const content = next.content?.trim()
        ? next.content
        : (errorNote ? `Stream interrupted: ${errorNote}` : next.content);
      return {
        ...next,
        content,
        interrupted: true,
      };
    })
    .filter((message): message is ChatMessage => message !== null);
}

export function renderCompactProgressBar(percent: number, width = 16): string {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

/** Latest in-flight compact progress percent from UI messages, if any. */
export function latestCompactProgressPercent(
  messages: readonly ChatMessage[],
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'system' || message.compact?.phase !== 'progress') continue;
    const percent = message.compact.percent;
    if (typeof percent === 'number' && Number.isFinite(percent)) {
      return Math.max(0, Math.min(100, Math.round(percent)));
    }
  }
  return undefined;
}

/** Status-line text for compacting: label + bar + percent. */
export function formatCompactingStatusLabel(input: {
  readonly label: string;
  readonly percent?: number;
  readonly barWidth?: number;
}): string {
  const base = input.label.trim() || 'Compacting';
  if (typeof input.percent !== 'number' || !Number.isFinite(input.percent)) {
    return base;
  }
  const percent = Math.max(0, Math.min(100, Math.round(input.percent)));
  return `${base} ${renderCompactProgressBar(percent, input.barWidth ?? 16)} ${percent}%`;
}

export function createChatController(options: {
  readonly host: TuiHost;
  readonly model: ChatModelPort;
  readonly sessionId?: string;
  readonly conversationId?: string;
  /** Resolve the persisted conversation at turn start so /new and /resume cannot reuse stale identity. */
  readonly getConversationId?: () => string;
  readonly initialMode?: TuiMode;
  readonly sessionController?: RuntimeSessionController;
  readonly planCoordinator?: PlanCoordinator;
  /** Optional live context-window resolver for auto-compact thresholds / pressure. */
  readonly getContextWindow?: () => number | undefined;
}): ChatController {
  const listeners = new Set<(snapshot: ChatSnapshot) => void>();
  const sessionId = options.sessionId ?? 'tui-chat';
  const resolveConversationId = options.getConversationId
    ?? (() => options.conversationId ?? sessionId);
  const initialMode = normalizeTuiMode(options.initialMode);
  let snapshot: ChatSnapshot = { status: 'idle', mode: initialMode, messages: [] };
  let activeTurn: RuntimeSessionTurnHandle | null = null;
  let conversationModelMessages: readonly ModelMessage[] = [];
  let conversationContinuityContext: string | undefined;
  let executionEvidenceIds: string[] = [];
  let sequence = 0;
  let goalTurnCollector: {
    readonly explorers: TuiExplorerRequest[];
    toolCallCount: number;
  } | null = null;
  const sessions = options.sessionController ?? createRuntimeSessionController();
  const goalWorkers = createTuiGoalWorkerAdapter({
    model: options.model,
    host: options.host,
  });

  const publish = (next: ChatSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  const resolveContextWindow = (): number | undefined => {
    const value = options.getContextWindow?.();
    return Number.isFinite(value) && (value as number) > 0
      ? Math.floor(value as number)
      : undefined;
  };

  const resolveToolsForPressure = () => {
    const mode = snapshot.mode;
    return options.host.toolDefinitionsForMode?.(mode) ?? options.host.toolDefinitions;
  };

  // Layer 1 投影缓存:同一 messages 引用只微压缩一次,避免每次 publish 重扫长会话。
  // 显示/触发分子与实际发送切片(provider-chat-model 同一共享 microcompact)同口径,
  // 消除「TUI 显示原文量、Desktop 显示投影量」的跨端分叉。
  let microProjectionCache: {
    source: readonly ModelMessage[];
    projected: readonly ModelMessage[];
  } | null = null;
  const microProjected = (messages: readonly ModelMessage[]): readonly ModelMessage[] => {
    if (microProjectionCache?.source === messages) return microProjectionCache.projected;
    const projected = microcompactMessagesForContext(messages).messages;
    microProjectionCache = { source: messages, projected };
    return projected;
  };

  const pressureFor = (
    messages: readonly ModelMessage[],
    usage?: ModelUsage,
    draftText?: string,
  ) => {
    const continuityBlocks = conversationContinuityContext
      ? [{
          id: 'conversation.compaction',
          title: 'Conversation Continuity',
          content: conversationContinuityContext,
          layer: 'L7_CONTINUITY',
          trust: 'runtime',
        }]
      : undefined;
    const systemMessages = options.model.projectSystemMessages?.({
      mode: snapshot.activeTurnMode ?? snapshot.mode,
      conversationId: resolveConversationId(),
      ...(continuityBlocks ? { systemContextBlocks: continuityBlocks } : {}),
    }) ?? [];
    return computeContextPressure({
      messages: [
        ...systemMessages,
        ...microProjected(messages).filter((message) => message.role !== 'system'),
      ],
      usage,
      contextWindow: resolveContextWindow(),
      draftText,
      // Desktop computeContextBudget folds tools schema into nextRequestInputTokens.
      tools: resolveToolsForPressure(),
    });
  };

  const withPressure = (
    next: ChatSnapshot,
    messages: readonly ModelMessage[] = conversationModelMessages,
  ): ChatSnapshot => {
    const pressure = pressureFor(messages, next.usage);
    return {
      ...next,
      nextRequestInputTokens: next.nextRequestInputTokens ?? pressure.nextRequestInputTokens,
      compactionPressureTokens: pressure.compactionPressureTokens,
    };
  };


  const runStructuralCompact = async (opts: {
    readonly source: 'manual' | 'auto';
  }): Promise<ChatCompactResult> => {
    const beforeCount = conversationModelMessages.length;
    if (beforeCount === 0) {
      return {
        ok: true,
        compacted: false,
        beforeCount: 0,
        afterCount: 0,
        summarizedCount: 0,
        notice: opts.source === 'auto' ? 'Auto-compact skipped: empty context' : 'Nothing to compact',
      };
    }

    const progressId = `compact-${++sequence}`;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const previousStatus = snapshot.status;
    publish({
      ...snapshot,
      status: 'compacting',
      error: undefined,
    });

    const label = opts.source === 'auto' ? 'Auto-compacting context' : 'Compacting context';
    const publishProgress = (percent: number) => {
      const content = `${label}  ${renderCompactProgressBar(percent)}  ${percent}%`;
      const progressMessage: ChatMessage = {
        id: progressId,
        role: 'system',
        content,
        pending: true,
        compact: { phase: 'progress', percent },
      };
      const without = snapshot.messages.filter((message) => message.id !== progressId);
      publish(withPressure({
        ...snapshot,
        status: 'compacting',
        messages: [...without, progressMessage],
        plan: snapshot.plan,
        usage: snapshot.usage,
        error: undefined,
      }));
    };

    // Soft stage floors before stream tokens arrive; live percent uses received/estimated.
    publishProgress(COMPACTION_PROGRESS_CONFIG.stageStartedPercent);
    await sleep(25);
    publishProgress(COMPACTION_PROGRESS_CONFIG.stagePreparedPercent);
    const previousContinuity = conversationContinuityContext?.trim();
    const strategy = await compactMessagesWithSummaryStrategy({
      messages: conversationModelMessages,
      keepRecentCount: opts.source === 'auto' ? TUI_COMPACT_KEEP_RECENT : 0,
      preserveLatestUserTurn: opts.source === 'auto',
      summarizeWithLlm: options.model.summarizeCompaction
        ? (oldMessages) => options.model.summarizeCompaction!({
            messages: oldMessages as readonly ModelMessage[],
            formattedHistory: formatCompactionMessagesForSummary(oldMessages),
            // Percent is already estimateCompactionProgressPercent from runtime-core.
            onProgress: (percent) => publishProgress(percent),
          })
        : undefined,
      summarizeStructurally: (oldMessages) => [
        previousContinuity,
        buildStructuralSummary(oldMessages as readonly ModelMessage[]),
      ].filter(Boolean).join('\n\n'),
      buildHandoffContent,
      fallbackSummary:
        previousContinuity || 'Earlier conversation was removed because no safe summary could be produced.',
    });
    if (!strategy.compacted) {
      const result = {
        compacted: false,
        beforeCount,
        afterCount: beforeCount,
        reason: beforeCount === 0 ? 'empty' : 'nothing-to-compact',
      } as const;
      const notice =
        result.reason === 'empty'
          ? (opts.source === 'auto' ? 'Auto-compact skipped: empty context' : 'Nothing to compact')
          : (opts.source === 'auto' ? 'Auto-compact skipped: already compact enough' : 'Context is already compact enough');
      publish(withPressure({
        ...snapshot,
        status: previousStatus === 'compacting' ? 'idle' : previousStatus,
        messages: snapshot.messages.filter((message) => message.id !== progressId),
        plan: snapshot.plan,
        usage: snapshot.usage,
        error: undefined,
      }));
      return {
        ok: true,
        compacted: false,
        beforeCount: result.beforeCount,
        afterCount: result.afterCount,
        summarizedCount: 0,
        notice,
      };
    }

    publishProgress(COMPACTION_PROGRESS_CONFIG.stagePostProcessPercent);
    await sleep(25);
    const summary = strategy.summary!.trim();
    const handoffContent = strategy.handoffContent!;
    const result = {
      compacted: true,
      messages: [...strategy.systemMessages, ...strategy.keepMessages] as readonly ModelMessage[],
      beforeCount,
      afterCount: strategy.systemMessages.length + strategy.keepMessages.length,
      summarizedCount: strategy.oldMessages.length,
      summary,
      handoffContent,
      method: strategy.method!,
      retainedUserCount: strategy.keepMessages.filter((message) => message.role === 'user').length,
    } as const;
    const previousProjection = snapshot.requestProjection;
    const previousMessageTokens = estimateTokensFromMessages(conversationModelMessages);
    const previousContinuityTokens = conversationContinuityContext
      ? estimateTokensFromMessages([{ role: 'system', content: conversationContinuityContext }])
      : 0;
    conversationModelMessages = result.messages
      .filter((message) => !(
        message.role === 'user'
        && typeof message.content === 'string'
        && message.content === result.handoffContent
      )) as ModelMessage[];
    conversationContinuityContext = result.summary?.trim() || result.handoffContent?.trim() || undefined;
    const compactedContextTokens =
      estimateTokensFromMessages(conversationModelMessages)
      + (conversationContinuityContext
        ? estimateTokensFromMessages([{ role: 'system', content: conversationContinuityContext }])
        : 0);
    const requestProjection = previousProjection
      ? {
          ...previousProjection,
          nextRequestInputTokens:
            compactedContextTokens
            + Math.max(
              0,
              previousProjection.nextRequestInputTokens
                - previousMessageTokens
                - previousContinuityTokens,
            ),
        }
      : undefined;
    const prefix = opts.source === 'auto' ? 'Auto-compacted' : 'Compacted';
    const doneContent =
      `${prefix} ${result.beforeCount} → ${result.afterCount} messages` +
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
        ...(previousProjection ? { beforeTokens: previousProjection.nextRequestInputTokens } : {}),
        ...(requestProjection ? { afterTokens: requestProjection.nextRequestInputTokens } : {}),
        summary: result.summary,
        handoffContent: result.handoffContent,
        method: result.method,
        retainedUserCount: result.retainedUserCount,
      },
    };
    // Preserve UI transcript and usage; only provider history shrinks. Progress row becomes a durable separator.
    const withoutProgress = snapshot.messages.filter((message) => message.id !== progressId);
    publish(withPressure({
      ...snapshot,
      status: previousStatus === 'compacting' ? 'idle' : previousStatus,
      messages: [...withoutProgress, doneMessage],
      plan: snapshot.plan,
      usage: snapshot.usage,
      requestProjection,
      nextRequestInputTokens: requestProjection?.nextRequestInputTokens,
      error: undefined,
    }));

    return {
      ok: true,
      compacted: true,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      summarizedCount: result.summarizedCount,
      notice:
        opts.source === 'auto'
          ? `Auto-compacted model context ${result.beforeCount} → ${result.afterCount} messages (summarized ${result.summarizedCount})`
          : `Compacted model context ${result.beforeCount} → ${result.afterCount} messages (summarized ${result.summarizedCount})`,
    };
  };


  const streamDeltaBuffer: Array<{
    readonly type: 'message.delta' | 'reasoning.delta';
    readonly content: string;
  }> = [];
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Shared per-turn projection lifecycle owns stream accumulation and stable
  // tool-result replacement. The TUI adapter only publishes its snapshots.
  let turnProjectionLifecycle: ContextProjectionLifecycle | null = null;
  let turnStableModelMessageCount = 0;

  const appendAssistantDelta = (
    messages: ChatMessage[],
    event: { readonly type: 'message.delta' | 'reasoning.delta'; readonly content: string },
  ) => {
    if (!event.content) return;
    const ensurePendingAssistant = (): ChatMessage => {
      const current = messages.at(-1);
      if (current?.role === 'assistant' && current.pending) return current;
      const created: ChatMessage = {
        id: `assistant-${++sequence}`,
        role: 'assistant',
        content: '',
        pending: true,
        segments: [],
      };
      messages.push(created);
      return created;
    };

    if (event.type === 'message.delta') {
      const target = ensurePendingAssistant();
      const segments = [...(target.segments ?? [])];
      const lastSeg = segments.at(-1);
      if (lastSeg?.type === 'text') {
        segments[segments.length - 1] = {
          type: 'text',
          content: lastSeg.content + event.content,
        };
      } else {
        segments.push({ type: 'text', content: event.content });
      }
      messages[messages.length - 1] = withDerivedAssistantFields(target, segments);
      return;
    }

    // reasoning.delta → thinking segment; open a new one after tool/text so order is preserved
    const target = ensurePendingAssistant();
    const segments = [...(target.segments ?? [])];
    const lastSeg = segments.at(-1);
    if (lastSeg?.type === 'thinking') {
      segments[segments.length - 1] = {
        type: 'thinking',
        content: lastSeg.content + event.content,
      };
    } else {
      segments.push({ type: 'thinking', content: event.content });
    }
    messages[messages.length - 1] = withDerivedAssistantFields(target, segments);
  };

  const flushStreamDeltaBuffer = () => {
    if (streamFlushTimer) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    if (streamDeltaBuffer.length === 0) return;
    const events = streamDeltaBuffer.splice(0, streamDeltaBuffer.length);
    const messages = [...snapshot.messages];
    let previewInputTokens: number | null = null;
    for (const event of events) {
      appendAssistantDelta(messages, event);
      if (event.type === 'message.delta') {
        previewInputTokens = turnProjectionLifecycle
          ?.streamPreview(event.content)
          .projection.previewInputTokens ?? null;
      }
    }
    publish({
      ...snapshot,
      messages,
      nextRequestInputTokens: previewInputTokens ?? snapshot.nextRequestInputTokens,
    });
  };

  const enqueueStreamDelta = (event: { readonly type: 'message.delta' | 'reasoning.delta'; readonly content: string }) => {
    if (!event.content) return;
    streamDeltaBuffer.push(event);
    if (streamFlushTimer) return;
    streamFlushTimer = setTimeout(flushStreamDeltaBuffer, STREAM_BUFFER_FLUSH_MS);
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
    lifecycle: {
      toolResultsApplied(state, executions) {
        flushStreamDeltaBuffer();
        const pressure = pressureFor(state.modelMessages, state.usage);
        const pendingStart = state.modelMessages.length >= turnStableModelMessageCount
          ? turnStableModelMessageCount
          : Math.max(0, state.modelMessages.length - executions.length - 1);
        const pendingMessages = state.modelMessages.slice(pendingStart);
        const pendingInputTokens = estimateTokensFromMessages(pendingMessages);
        // The last provider observation is the stable request baseline. Model
        // output plus retained tool results are explicit pending preview, never
        // a competing whole-history estimate.
        const stableInputTokens = pressure.usageTokens > 0
          ? pressure.usageTokens + pendingInputTokens
          : pressure.estimatedTokens;
        turnStableModelMessageCount = state.modelMessages.length;
        const projection = turnProjectionLifecycle?.toolResult({
          contextWindow: resolveContextWindow(),
          currentInputTokens: stableInputTokens,
          reason: 'tool_result',
        });
        publish({
          ...snapshot,
          nextRequestInputTokens:
            projection?.projection.nextRequestInputTokens
            ?? stableInputTokens,
          // A tool result is a stable preflight boundary, but automatic
          // compaction still waits for the shared provider accounting gate.
          compactionPressureTokens:
            pressure.usageTokens > 0
              ? pressure.usageTokens
              : stableInputTokens,
        });
      },
    },
    tools: {
      async execute(call, context) {
        if (goalTurnCollector) goalTurnCollector.toolCallCount += 1;
        // Attach tool-call progress to the current assistant turn (Desktop model):
        // multiple tools share one assistant message via `tools[]` / segments.
        flushStreamDeltaBuffer();
        const startedAt = Date.now();
        const runningTool = createToolPresentation({
          capabilityId: call.capabilityId,
          toolCallId: call.toolCallId,
          arguments: call.arguments,
          status: 'running',
          outputPreview: 'running',
          startedAt,
        });
        publish({
          ...snapshot,
          messages: upsertAssistantTool(snapshot.messages, runningTool, () => ++sequence),
        });

        const execution = await options.host.execute(call.capabilityId, call.arguments, {
          sessionId: context.run.sessionId,
          ...(context.run.conversationId
            ? { conversationId: context.run.conversationId }
            : {}),
          ...(context.run.streamId ? { streamId: context.run.streamId } : {}),
          mode: normalizeTuiRuntimeMode(context.run.mode),
          turnId: context.run.input.turnId,
          turnIndex: context.run.input.turnIndex,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        if (
          goalTurnCollector
          && call.capabilityId === GOAL_CAPABILITY_IDS.explore
          && execution.result.status === 'success'
        ) {
          const request = normalizeExplorerRequest(call.arguments);
          if (request) goalTurnCollector.explorers.push(request);
        }
        const evidence = execution.result.evidence;
        const evidenceId = evidence && typeof evidence === 'object' && 'evidenceId' in evidence
          ? String(evidence.evidenceId)
          : '';
        if (evidenceId) executionEvidenceIds = [...executionEvidenceIds, evidenceId];
        const tool = createToolPresentation({
          capabilityId: call.capabilityId,
          toolCallId: call.toolCallId,
          arguments: call.arguments,
          status: execution.result.status,
          outputPreview: execution.result.outputPreview,
          errorMessage: execution.result.error && typeof execution.result.error === 'object'
            && 'message' in execution.result.error
            ? String((execution.result.error as { message?: unknown }).message ?? '')
            : null,
          startedAt,
          completedAt: Date.now(),
        });
        // Complete the same tool entry in-place on the assistant turn.
        publish({
          ...snapshot,
          messages: upsertAssistantTool(snapshot.messages, tool, () => ++sequence),
        });
        const control = (execution.result as { control?: { terminal?: unknown; reason?: unknown } } | undefined)?.control
          ?? ((execution.result as { output?: { control?: { terminal?: unknown; reason?: unknown } } } | undefined)?.output?.control)
          ?? ((execution.result as { metadata?: { control?: { terminal?: unknown; reason?: unknown } } } | undefined)?.metadata?.control);
        const terminal = control?.terminal === true
          || call.capabilityId === 'local.interaction.request_user_input'
          || call.name === 'request_user_input';
        return {
          call,
          result: execution,
          ...(terminal
            ? {
                terminal: true,
                terminalReason: typeof control?.reason === 'string' ? control.reason : 'request_user_input',
              }
            : {}),
        };
      },
    },
    events: {
      emit(event) {
        if (event.type === 'message.delta' || event.type === 'reasoning.delta') {
          enqueueStreamDelta(event);
          return null;
        }
        if (event.type === 'compaction.progress') {
          const percent = Math.max(0, Math.min(100, Math.round(Number(event.percent) || 0)));
          const label = typeof event.label === 'string' && event.label.trim()
            ? event.label.trim()
            : 'Auto-compacting context';
          const progressId = `midturn-compact-${event.streamId ?? 'tui-chat'}`;
          const content = `${label}  ${renderCompactProgressBar(percent)}  ${percent}%`;
          const progressMessage: ChatMessage = {
            id: progressId,
            role: 'system',
            content,
            pending: percent < 100,
            compact: {
              phase: percent >= 100 || event.phase === 'done' ? 'done' : 'progress',
              percent,
            },
          };
          const without = snapshot.messages.filter((message) => message.id !== progressId);
          publish(withPressure({
            ...snapshot,
            status: percent >= 100 || event.phase === 'done' ? 'running' : 'compacting',
            messages: percent >= 100 || event.phase === 'done'
              ? without
              : [...without, progressMessage],
            plan: snapshot.plan,
            usage: snapshot.usage,
            error: undefined,
          }));
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
      conversationModelMessages = input.modelMessages
        ? [...input.modelMessages]
        : messages
            .filter((message) => message.role === 'user' || message.role === 'assistant')
            .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
      conversationContinuityContext = input.continuityContext?.trim() || undefined;
      executionEvidenceIds = [];
      sequence = restoredMessageSequence(messages);
      // 恢复时不直信持久化快照的分子(可能是旧版全量口径):本地按当前
      // 发送口径(共享 microcompact 投影)重算,与 Desktop restored 重投影同精神;
      // 快照的 model/contextWindow 元信息保留。
      const restoredPressure = pressureFor(conversationModelMessages, input.usage);
      const restoredProjection = input.requestProjection
        ? { ...input.requestProjection, nextRequestInputTokens: restoredPressure.nextRequestInputTokens }
        : undefined;
      publish(withPressure({
        status: 'idle',
        mode: normalizeTuiMode(input.mode),
        messages,
        usage: input.usage,
        requestProjection: restoredProjection,
        nextRequestInputTokens: restoredPressure.nextRequestInputTokens,
      }));
      return true;
    },
    async send(content, sendOptions) {
      const trimmed = content.trim();
      const images = sendOptions?.images?.filter((image) => Boolean(image.url)) ?? [];
      const hideFromUi = sendOptions?.hideFromUi === true;
      if ((!trimmed && images.length === 0) || activeTurn) return;

      // Pre-send auto-compact: same soft threshold as Desktop
      // (compactionPressureTokens >= 0.8 * window).
      // Uses structural compact (manual /compact path), not Desktop LLM summarizer.
      const draftForPressure = trimmed
        || (images.length > 0 ? `[image${images.length > 1 ? 's' : ''}]` : '');
      const preflightPressure = pressureFor(
        conversationModelMessages,
        snapshot.usage,
        draftForPressure,
      );
      if (preflightPressure.shouldCompact) {
        await runStructuralCompact({ source: 'auto' });
      }
      const conversationId = resolveConversationId();
      let existingSession = sessions.get(sessionId);
      if (existingSession && existingSession.conversationId !== conversationId) {
        if (!sessions.delete(sessionId)) {
          throw new Error(`Cannot switch conversation while runtime session ${sessionId} is active`);
        }
        existingSession = null;
      }
      activeTurn = existingSession
        ? sessions.resume({ sessionId, streamId: `${sessionId}:stream:${existingSession.nextTurnIndex}` })
        : sessions.start({
            sessionId,
            conversationId,
            streamId: `${sessionId}:stream:0`,
          });
      const turn = activeTurn;
      const turnMode = snapshot.mode;
      // Continuing a conversation retires historical interrupted markers so Desktop no longer
      // keeps a stale "已中断 / 继续生成" state on older assistant turns.
      const clearedMessages = clearInterruptedMarkers(snapshot.messages).messages;
      const history = clearedMessages.filter(
        (message) => !message.pending && message.role !== 'system',
      );
      // Keep system separators in the UI transcript while excluding them from turn history.
      const uiMessages = clearedMessages.filter((message) => !message.pending);
      const userContent = trimmed
        || (images.length > 0 ? `[image${images.length > 1 ? 's' : ''}]` : '');
      // Provider usage for this turn is not available yet. Project the exact request-visible
      // transcript now so the running frame cannot temporarily collapse context occupancy to 0%.
      const preflightMessages: readonly ModelMessage[] = [
        ...conversationModelMessages,
        { role: 'user', content: userContent },
      ];
      turnStableModelMessageCount = preflightMessages.length;
      const runningPressure = pressureFor(preflightMessages, snapshot.usage);
      turnProjectionLifecycle = createContextProjectionLifecycle();
      const runningProjection = turnProjectionLifecycle.requestPreflight({
        contextWindow: resolveContextWindow(),
        currentInputTokens: runningPressure.nextRequestInputTokens,
        reason: 'request_preflight',
      }).projection;
      const preflightProjection = snapshot.requestProjection
        ? {
            ...snapshot.requestProjection,
            nextRequestInputTokens:
              runningProjection.nextRequestInputTokens
              ?? runningPressure.nextRequestInputTokens,
            contextWindow: resolveContextWindow() ?? snapshot.requestProjection.contextWindow,
          }
        : undefined;
      publish({
        status: 'running',
        mode: turnMode,
        activeTurnMode: turnMode,
        session: sessions.get(sessionId) ?? undefined,
        usage: snapshot.usage,
        nextRequestInputTokens:
          runningProjection.nextRequestInputTokens
          ?? runningPressure.nextRequestInputTokens,
        compactionPressureTokens: runningPressure.compactionPressureTokens,
        requestProjection: preflightProjection,
        messages: [
          ...uiMessages,
          // Desktop parity: Goal Runner ticks feed the model (preflightMessages)
          // but do not render a synthetic user bubble in the transcript.
          ...(hideFromUi
            ? []
            : [{
                id: `user-${++sequence}`,
                role: 'user' as const,
                content: userContent,
                ...(images.length > 0 ? { images } : {}),
              }]),
          // Insert a pending assistant immediately so the UI can show a Thinking
          // transition state before the first token arrives (Claude Code / Qoder style).
          {
            id: `assistant-${++sequence}`,
            role: 'assistant',
            content: '',
            pending: true,
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
              ...(snapshot.usage ? { usage: snapshot.usage } : {}),
              ...(conversationContinuityContext
                ? {
                    systemContextBlocks: [{
                      id: 'conversation.compaction',
                      title: 'Conversation Continuity',
                      content: conversationContinuityContext,
                      layer: 'conversation',
                      trust: 'continuity',
                    }],
                  }
                : {}),
              turnId: turn.turnId,
              turnIndex: turn.turnIndex,
            },
          },
          { signal: turn.signal },
        );
        flushStreamDeltaBuffer();
        if (result.state) conversationModelMessages = result.state.modelMessages;

        // turn 内自动压缩收尾(preflight/emergency):连续性 carry-forward、从 provider 历史
        // 剔除 handoff(TUI 约定:摘要走 system continuity)、发布压缩分隔消息——
        // persistence 据其 compact meta 写入共享 `_compaction` marker。
        const midTurnCompactions = result.state?.midTurnCompactions ?? [];
        let midTurnCompactMessage: ChatMessage | null = null;
        if (midTurnCompactions.length > 0) {
          for (const record of midTurnCompactions) {
            const previous = conversationContinuityContext?.trim();
            conversationContinuityContext = previous
              ? [
                  '## Previous compacted context',
                  previous,
                  '',
                  '## Newly compacted context',
                  record.summary,
                ].join('\n')
              : record.summary;
          }
          const handoffContents = new Set(midTurnCompactions.map((record) => record.handoffContent));
          conversationModelMessages = conversationModelMessages.filter((message) => !(
            message.role === 'user'
            && typeof message.content === 'string'
            && handoffContents.has(message.content)
          ));
          const last = midTurnCompactions[midTurnCompactions.length - 1]!;
          midTurnCompactMessage = {
            id: `compact-${++sequence}`,
            role: 'system',
            content: `Auto-compacted mid-turn ${last.beforeCount} → ${last.afterCount} messages (summarized ${last.summarizedCount})`,
            compact: {
              phase: 'done',
              percent: 100,
              method: last.method,
              beforeCount: last.beforeCount,
              afterCount: last.afterCount,
              summarizedCount: last.summarizedCount,
              beforeTokens: last.beforeTokens,
              afterTokens: last.afterTokens,
              summary: conversationContinuityContext,
              handoffContent: last.handoffContent,
              retainedUserCount: last.retainedUserCount,
            },
          };
        }

        if (result.status === 'cancelled') turn.cancel(result.reason);
        else if (result.status === 'exhausted') turn.fail('turn_limit_exhausted');
        else if (result.status === 'failed') turn.fail(result.reason || 'provider_stream_error');
        else turn.complete();

        // Plan and Goal both surface a draft plan for approval before execution.
        // Goal mode still publishes first so the TUI approval + goal runner path can start.
        if (
          (turnMode === 'plan' || turnMode === 'goal')
          && result.status === 'completed'
          && result.output
        ) {
          const plan = parseRuntimePlanText(result.output);
          if (plan) options.planCoordinator?.publish(plan);
        }

        const failed = result.status === 'failed' || result.status === 'exhausted';
        const failureDetail = result.status === 'exhausted'
          ? 'The model exhausted its turn limit.'
          : result.status === 'failed'
            ? (result.reason || 'provider_stream_error')
            : undefined;
        const completedPressure = pressureFor(
          conversationModelMessages,
          result.state?.usage,
        );
        const completedProjection = turnProjectionLifecycle?.turnComplete({
          contextWindow: resolveContextWindow(),
          currentInputTokens: completedPressure.nextRequestInputTokens,
          reason: 'turn_complete',
        }).projection;
        publish(withPressure({
          status: 'idle',
          mode: snapshot.mode,
          session: sessions.get(sessionId) ?? undefined,
          plan: options.planCoordinator?.getSnapshot() ?? undefined,
          usage: result.state?.usage,
          requestProjection: result.state?.requestProjection,
          nextRequestInputTokens:
            completedProjection?.nextRequestInputTokens
            ?? completedPressure.nextRequestInputTokens,
          messages: [
            ...finalizePendingMessages(snapshot.messages, {
              interrupted: failed,
              error: failureDetail,
            }),
            ...(midTurnCompactMessage ? [midTurnCompactMessage] : []),
          ],
          error: failureDetail,
        }));
      } catch (error) {
        flushStreamDeltaBuffer();
        const wasCancelled = turn.signal.aborted;
        const detail = errorMessage(error);
        if (wasCancelled) turn.cancel(detail);
        else turn.fail(detail);
        // Keep already-executed tool results and any partial assistant text.
        // Mark the latest assistant as interrupted so Desktop/TUI can recover.
        publish(withPressure({
          status: 'idle',
          mode: snapshot.mode,
          session: sessions.get(sessionId) ?? undefined,
          messages: finalizePendingMessages(snapshot.messages, {
            interrupted: !wasCancelled,
            error: detail,
          }),
          error: wasCancelled ? undefined : detail,
          usage: snapshot.usage,
        }));
      } finally {
        turnProjectionLifecycle = null;
        turnStableModelMessageCount = 0;
        if (activeTurn === turn) activeTurn = null;
      }
    },
    clear() {
      if (activeTurn) return false;
      conversationModelMessages = [];
      conversationContinuityContext = undefined;
      executionEvidenceIds = [];
      publish(withPressure({ status: 'idle', mode: snapshot.mode, messages: [] }, []));
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

      return runStructuralCompact({ source: 'manual' });
    },
    async runGoalTurn(content) {
      if (activeTurn || snapshot.status !== 'idle') {
        throw new Error('chat_turn_active');
      }
      if (goalTurnCollector) {
        throw new Error('goal_turn_collector_active');
      }

      const collector = {
        explorers: [] as TuiExplorerRequest[],
        toolCallCount: 0,
      };
      goalTurnCollector = collector;
      try {
        this.setMode('goal');
        // Hide Goal Runner tick text from the chat transcript (Desktop parity).
        await this.send(content, { hideFromUi: true });
        if (snapshot.error) {
          // Structured failure so Goal Runner can mark the plan/task failed
          // without relying only on thrown exceptions.
          return {
            continued: false as const,
            failed: true as const,
            failureReason: snapshot.error,
            terminalStatus: 'error' as const,
            explorers: [...collector.explorers],
            toolCallCount: collector.toolCallCount,
          };
        }
        return {
          continued: true as const,
          explorers: [...collector.explorers],
          toolCallCount: collector.toolCallCount,
        };
      } finally {
        if (goalTurnCollector === collector) goalTurnCollector = null;
      }
    },
    runExplorer(input) {
      return goalWorkers.runExplorer(input);
    },
    runVerifier(input) {
      return goalWorkers.runVerifier(input);
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
      flushStreamDeltaBuffer();
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
