import {
  collectToolEvidenceRefs,
  COMPACTION_PROGRESS_CONFIG,
  COMPACTION_SUMMARY_PROMPT,
  COMPACTION_SUMMARY_SYSTEM_PROMPT,
  compactMessagesWithSummaryStrategy,
  createContextAccountingCompactionPipeline,
  createRuntimeUsageAccounting,
  estimateCompactionProgressPercent,
  formatCompactionMessagesForSummary,
  microcompactMessagesForContext,
  resolveMaxSummaryChars,
  type RuntimeToolDefinition,
} from '@peer-agent/runtime-core';
import type {
  ModelContentPart,
  ModelMessage,
  ModelProvider,
  ModelReasoningEffort,
  ModelToolCall,
  ModelToolDefinition,
} from '@peer-agent/runtime-node';
import { encodeProviderToolResult } from '@peer-agent/runtime-node';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import type {
  ChatMessage,
  ChatMessageImage,
  ChatModelInput,
  ChatModelPort,
  ChatModelState,
  ChatModelToolCall,
  MidTurnCompaction,
} from './chat-controller.ts';
import {
  buildHandoffContent,
  buildStructuralSummary,
  TUI_COMPACT_KEEP_RECENT,
} from './context-compact.ts';
import { normalizeTuiRuntimeMode, type TuiRuntimeMode } from './tui-mode.ts';
import {
  DEFAULT_CONNECTION_RETRY_DELAYS_MS,
  describeConnectionFailure,
  isRecoverableConnectionFailure,
} from './recovering-fetch.ts';

function toUserModelContent(
  content: string,
  images?: readonly ChatMessageImage[],
): string | readonly ModelContentPart[] {
  if (!images || images.length === 0) return content;
  const parts: ModelContentPart[] = [];
  if (content.trim()) {
    parts.push({ type: 'text', text: content });
  }
  for (const image of images) {
    if (!image.url) continue;
    parts.push({ type: 'image_url', image_url: { url: image.url } });
  }
  return parts.length > 0 ? parts : content;
}

export interface CreateProviderChatModelOptions {
  readonly provider: ModelProvider;
  readonly getProvider?: () => ModelProvider;
  readonly model: string;
  readonly toolDefinitions?: readonly RuntimeToolDefinition[];
  readonly toolDefinitionsForMode?: (mode: TuiRuntimeMode) => readonly RuntimeToolDefinition[];
  readonly systemPrompt?: string;
  readonly getSystemPrompt?: (context: ProviderSystemPromptContext) => string;
  readonly getModel?: () => string;
  readonly getModelKey?: () => string;
  readonly getReasoningEffort?: () => ModelReasoningEffort;
  readonly getContextWindow?: () => number | undefined;
}

export interface ProviderSystemPromptContext {
  readonly mode: TuiRuntimeMode;
  readonly conversationId?: string;
  readonly systemContextBlocks?: ChatModelInput['systemContextBlocks'];
  readonly systemContextInput?: ChatModelInput['systemContextInput'];
}

function parameters(tool: RuntimeToolDefinition): Readonly<Record<string, unknown>> {
  if (tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)) {
    return tool.inputSchema as Readonly<Record<string, unknown>>;
  }
  return { type: 'object', properties: {} };
}

function toModelTool(tool: RuntimeToolDefinition): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: parameters(tool),
  };
}

/**
 * Recoverably parse model tool-call arguments.
 * Invalid JSON / non-object payloads must not crash the whole turn; wrap them so
 * Runtime can reject the tool call with a structured failure instead.
 */
function parseArguments(call: ModelToolCall): Record<string, unknown> {
  const raw = call.arguments;
  if (!raw || !raw.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { raw_arguments: raw };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { raw_arguments: raw };
  }

  return parsed as Record<string, unknown>;
}

function executionContent(execution: RuntimeSdkProviderExecution, conversationId?: string): string {
  const result = execution.result;
  const evidenceRefs = collectToolEvidenceRefs({
    toolCallId: result.toolCallId,
    execution,
  });
  // Layer 0: one encoded result for provider history. Do not wrap
  // output + outputPreview and rematerialize. File reads stay inline;
  // shell logs keep the shell artifact route.
  try {
    return encodeProviderToolResult({
      result,
      execution,
      conversationId,
      toolCallId: result.toolCallId,
      evidenceRefs,
    }).content;
  } catch {
    return JSON.stringify({
      status: result.status,
      ...(result.output === undefined ? {} : { output: result.output }),
      ...(result.error === undefined ? {} : { error: result.error }),
      ...(evidenceRefs.length === 0 ? {} : { evidenceRefs }),
    });
  }
}

/** One short whole-turn retry for recoverable connect/stream drops before any deltas. */
const DEFAULT_STREAM_RETRY_DELAYS_MS = DEFAULT_CONNECTION_RETRY_DELAYS_MS;

async function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (!(ms > 0)) return;
  if (signal?.aborted) {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function streamWithSafeRetry(
  provider: ModelProvider,
  request: Parameters<ModelProvider['stream']>[0],
  options: {
    readonly retryDelaysMs?: readonly number[];
    readonly waitImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly onRetry?: (info: { attempt: number; maxRetries: number; delayMs: number; reason: string }) => void;
  } = {},
): Promise<Awaited<ReturnType<ModelProvider['stream']>>> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_STREAM_RETRY_DELAYS_MS;
  const waitImpl = options.waitImpl ?? waitForRetry;
  const maxRetries = retryDelaysMs.length;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let progressEmitted = false;
    const originalOnEvent = request.onEvent;
    try {
      return await provider.stream({
        ...request,
        onEvent(event) {
          if (event.type === 'text.delta' || event.type === 'reasoning.delta') {
            progressEmitted = true;
          }
          originalOnEvent?.(event);
        },
      });
    } catch (error) {
      lastError = error;
      const canRetry =
        attempt < maxRetries
        && !progressEmitted
        && !request.signal?.aborted
        && isRecoverableConnectionFailure(error);
      if (!canRetry) throw error;
      const delayMs = retryDelaysMs[attempt] ?? 0;
      options.onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        reason: describeConnectionFailure(error),
      });
      await waitImpl(delayMs, request.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}


/** Align with Desktop: keep recent tail of summary input under a token budget. */
const TUI_SUMMARY_MAX_INPUT_TOKENS = 80_000;
const TUI_SUMMARY_CHARS_PER_TOKEN = 4;
const TUI_SUMMARY_SAFETY_RESERVE_TOKENS = 4_000;

export function truncateSummaryInputPreferTail(text: string, maxChars: number): string {
  const value = String(text ?? '');
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (value.length <= limit) return value;
  const marker = '\n...[summary input truncated: kept recent tail near compaction point; older head omitted]...\n';
  if (limit <= marker.length) return value.slice(-limit);
  const tailBudget = limit - marker.length;
  return `${marker}${value.slice(-tailBudget)}`;
}

export function resolveTuiSummaryInputMaxChars(options: {
  readonly contextWindow?: number | null;
  readonly maxOutputTokens?: number | null;
} = {}): number {
  const summaryMaxTokens = Math.max(
    1_024,
    Math.min(
      Number(options.maxOutputTokens) > 0 ? Number(options.maxOutputTokens) : 4_096,
      12_000,
    ),
  );
  let summaryMaxInputTokens = TUI_SUMMARY_MAX_INPUT_TOKENS;
  const windowTokens = Number(options.contextWindow);
  if (Number.isFinite(windowTokens) && windowTokens > 0) {
    const usableInput = Math.max(2_000, windowTokens - summaryMaxTokens - TUI_SUMMARY_SAFETY_RESERVE_TOKENS);
    summaryMaxInputTokens = Math.min(summaryMaxInputTokens, usableInput);
  }
  return Math.max(1, Math.floor(summaryMaxInputTokens * TUI_SUMMARY_CHARS_PER_TOKEN));
}

export function createProviderChatModel(options: CreateProviderChatModelOptions): ChatModelPort {
  const defaultToolDefinitions = options.toolDefinitions ?? [];
  const toolDefinitionsForMode = (mode: TuiRuntimeMode) =>
    options.toolDefinitionsForMode?.(mode) ?? defaultToolDefinitions;
  const systemMessagesFor = (context: ProviderSystemPromptContext): readonly ModelMessage[] => {
    const content = options.getSystemPrompt?.(context) ?? options.systemPrompt;
    return content ? [{ role: 'system', content }] : [];
  };

  const summarizeCompaction = async (input: {
    readonly messages: readonly ModelMessage[];
    readonly formattedHistory: string;
    readonly onProgress?: (percent: number) => void;
    readonly onUsage?: (
      usage: Awaited<ReturnType<ModelProvider['stream']>>['usage'],
    ) => void;
  }): Promise<string> => {
    let streamedChars = 0;
    const summaryInputMaxChars = resolveTuiSummaryInputMaxChars({
      contextWindow: typeof (options as { contextWindow?: number }).contextWindow === 'number'
        ? (options as { contextWindow?: number }).contextWindow
        : undefined,
      maxOutputTokens: 4096,
    });
    const boundedHistory = truncateSummaryInputPreferTail(input.formattedHistory, summaryInputMaxChars);
    const inputChars = boundedHistory.length;
    const maxSummaryChars = resolveMaxSummaryChars({ maxOutputTokens: 4096 });
    const reportLiveProgress = () => {
      input.onProgress?.(
        estimateCompactionProgressPercent({
          inputChars,
          maxSummaryChars,
          receivedChars: streamedChars,
          minPercent: COMPACTION_PROGRESS_CONFIG.stagePreparedPercent,
        }),
      );
    };
    let result: Awaited<ReturnType<ModelProvider['stream']>>;
    try {
      result = await streamWithSafeRetry((options.getProvider?.() ?? options.provider), {
        model: options.getModel?.() ?? options.model,
        messages: [
          { role: 'system', content: COMPACTION_SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: boundedHistory },
          { role: 'user', content: COMPACTION_SUMMARY_PROMPT },
        ],
        tools: [],
        temperature: 0.2,
        maxOutputTokens: 4096,
        onEvent(event) {
          if (event.type !== 'text.delta') return;
          streamedChars += event.content.length;
          // Shared Desktop/CLI progress: received/estimated summary chars.
          reportLiveProgress();
        },
      });
    } catch (error) {
      input.onUsage?.(undefined);
      throw error;
    }
    // Live stream never reports 100; controller post-process + done own the finish.
    reportLiveProgress();
    input.onUsage?.(result.usage);
    return result.content;
  };

  return {
    projectSystemMessages(context) {
      return systemMessagesFor({
        mode: normalizeTuiRuntimeMode(context.mode),
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        systemContextBlocks: context.systemContextBlocks,
        systemContextInput: context.systemContextInput,
      });
    },
    summarizeCompaction,
    initialize(input, context) {
      const mode = normalizeTuiRuntimeMode(context.run.mode);
      const systemMessages = systemMessagesFor({
        mode,
        ...(context.run.conversationId ? { conversationId: context.run.conversationId } : {}),
        systemContextBlocks: input.input.systemContextBlocks,
        systemContextInput: input.input.systemContextInput,
      });
      const userContent = toUserModelContent(input.input.content, input.input.images);
      // System Context is rebuilt from current host facts every turn. Never retain
      // a previous host's prompt or accumulate duplicate system messages.
      const historyWithoutSystem = input.input.modelMessages.filter(
        (message) => message.role !== 'system',
      );
      const modelMessages: ModelMessage[] = [
        ...systemMessages,
        ...historyWithoutSystem,
        { role: 'user', content: userContent },
      ];
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
        modelMessages,
        toolExecutions: [],
        // A resumed usage value belongs to an earlier runtime turn. Every new
        // turn starts a fresh accumulator while context capacity resumes from
        // contextAccounting only.
        usageAccounting: createRuntimeUsageAccounting(),
        ...(input.input.contextAccounting
          ? { contextAccounting: input.input.contextAccounting }
          : {}),
        // 供工具结果材料化按会话归档 artifact(跨端共享 ~/.peer-agent/artifacts/<conv>)。
        ...(context.run.conversationId ? { conversationId: context.run.conversationId } : {}),
      };
    },
    async runTurn(state, context) {
      const mode = normalizeTuiRuntimeMode(context.run.mode);
      const projectedToolDefinitions = toolDefinitionsForMode(mode);
      const toolsByName = new Map(projectedToolDefinitions.map((tool) => [tool.name, tool]));
      const tools = projectedToolDefinitions.map(toModelTool);
      const streamId = context.run.streamId ?? 'tui-chat';
      const reasoningEffort = options.getReasoningEffort?.();
      const model = options.getModel?.() ?? options.model;
      const modelKey = options.getModelKey?.() ?? model;
      const activeProvider = options.getProvider?.() ?? options.provider;
      const contextWindowRaw = Number(options.getContextWindow?.());
      const contextWindow = Number.isFinite(contextWindowRaw) && contextWindowRaw > 0
        ? Math.floor(contextWindowRaw)
        : null;
      const usageAccounting = state.usageAccounting ?? createRuntimeUsageAccounting();
      const midTurnCompactions: MidTurnCompaction[] = [];
      type PipelineState = Readonly<{ messages: readonly ModelMessage[] }>;
      type CanonicalRequest = Readonly<{
        model: string;
        messages: readonly ModelMessage[];
        tools: readonly ModelToolDefinition[];
        reasoningEffort?: ModelReasoningEffort;
      }>;
      const accountingPipeline = createContextAccountingCompactionPipeline<
        PipelineState,
        CanonicalRequest,
        Awaited<ReturnType<ModelProvider['stream']>>
      >({
        identity: {
          conversationId: context.run.conversationId ?? context.run.sessionId,
          contentRevision: (state.contextAccounting?.contentRevision ?? 0) + 1,
          modelKey,
        },
        contextWindow,
        countCapability:
          activeProvider.contextCountCapability
          ?? (activeProvider.countInputTokens
            ? { kind: 'provider_tokenizer', tokenizerVersion: 'provider-adapter' }
            : { kind: 'observed_usage_only' }),
        initialSnapshot: state.contextAccounting,
        countRequest: activeProvider.countInputTokens
          ? (request) => activeProvider.countInputTokens!(request)
          : undefined,
        onSnapshot(snapshot) {
          context.emit({
            type: 'context.accounting',
            streamId,
            snapshot,
          });
        },
        buildRequest(pipelineState) {
          return {
            model,
            messages: microcompactMessagesForContext(pipelineState.messages).messages,
            tools,
            ...(!reasoningEffort || reasoningEffort === 'default' ? {} : { reasoningEffort }),
          };
        },
        async compact({ state: pipelineState, reason }) {
          const compactReason = reason === 'provider_overflow' ? 'overflow' : 'preflight';
          const emitCompactionProgress = (
            percent: number,
            phase: 'started' | 'progress' | 'done' = 'progress',
          ) => {
            const clamped = Math.max(0, Math.min(100, Math.round(percent)));
            context.emit({
              type: 'compaction.progress',
              streamId,
              percent: clamped,
              reason: compactReason,
              phase,
              label: compactReason === 'overflow'
                ? 'Auto-compacting after overflow'
                : 'Auto-compacting context',
            });
          };

          // Align mid-turn compact with Desktop: LLM summary first, structural fallback.
          emitCompactionProgress(COMPACTION_PROGRESS_CONFIG.stageStartedPercent, 'started');
          emitCompactionProgress(COMPACTION_PROGRESS_CONFIG.stagePreparedPercent, 'progress');
          const strategy = await compactMessagesWithSummaryStrategy({
            messages: pipelineState.messages,
            keepRecentCount: TUI_COMPACT_KEEP_RECENT,
            preserveLatestUserTurn: true,
            summarizeWithLlm: async (oldMessages) => {
              const formattedHistory = formatCompactionMessagesForSummary(oldMessages);
              return summarizeCompaction({
                messages: oldMessages as readonly ModelMessage[],
                formattedHistory,
                onProgress: (percent) => emitCompactionProgress(percent, 'progress'),
                onUsage: (usage) => {
                  usageAccounting.observeProviderRequest(usage, {
                    requestPurpose: 'compaction_summary',
                    capacityBearing: false,
                  });
                },
              });
            },
            summarizeStructurally: (messages) =>
              buildStructuralSummary(messages as readonly ModelMessage[]),
            buildHandoffContent,
          });
          if (!strategy.compacted || !strategy.summary || !strategy.handoffContent) {
            emitCompactionProgress(100, 'done');
            return { compacted: false, state: pipelineState };
          }
          const nextMessages: readonly ModelMessage[] = [
            ...strategy.systemMessages,
            { role: 'user', content: strategy.handoffContent },
            ...strategy.keepMessages,
          ];
          emitCompactionProgress(COMPACTION_PROGRESS_CONFIG.stagePostProcessPercent, 'progress');
          midTurnCompactions.push({
            reason: reason === 'provider_overflow' ? 'emergency' : 'preflight',
            method: strategy.method ?? 'structured',
            beforeCount: pipelineState.messages.length,
            afterCount: nextMessages.length,
            summarizedCount: strategy.oldMessages.length,
            summary: strategy.summary,
            handoffContent: strategy.handoffContent,
            retainedUserCount: strategy.keepMessages.filter(
              (message) => message.role === 'user',
            ).length,
          });
          emitCompactionProgress(100, 'done');
          return { compacted: true, state: { messages: nextMessages } };
        },
        send(request) {
          return streamWithSafeRetry(activeProvider, {
            ...request,
            signal: context.signal,
            onEvent(event) {
              if (event.type === 'text.delta') {
                context.emit({ type: 'message.delta', streamId, content: event.content });
              }
              if (event.type === 'reasoning.delta') {
                context.emit({ type: 'reasoning.delta', streamId, content: event.content });
              }
            },
          });
        },
        getUsage(response) {
          return response.usage;
        },
        onProviderRequest({ usage, requestFingerprint }) {
          usageAccounting.observeProviderRequest(usage, {
            requestFingerprint,
          });
        },
      });
      const accountingResult = await accountingPipeline.execute({
        state: { messages: state.modelMessages },
      });
      const result = accountingResult.response;
      if (!result) throw new Error('Provider request completed without a response.');
      const workingMessages = accountingResult.state.messages;
      const turnUsage = usageAccounting.snapshot().turnTotal;

      const accumulatedCompactions = [
        ...(state.midTurnCompactions ?? []),
        ...midTurnCompactions,
      ];

      if (result.toolCalls.length > 0) {
        const calls: ChatModelToolCall[] = result.toolCalls.map((call) => {
          const tool = toolsByName.get(call.name);
          if (!tool) throw new Error(`Model requested an unavailable tool "${call.name}".`);
          return {
            toolCallId: call.id,
            capabilityId: tool.capabilityId,
            arguments: parseArguments(call),
          };
        });
        return {
          kind: 'tool_calls',
          state: {
            ...state,
            modelMessages: [
              ...workingMessages,
              { role: 'assistant', content: result.content || null, toolCalls: result.toolCalls },
            ],
            pendingToolCalls: result.toolCalls,
            usageAccounting,
            usage: turnUsage,
            contextAccounting: accountingResult.snapshot,
            ...(accumulatedCompactions.length > 0
              ? { midTurnCompactions: accumulatedCompactions }
              : {}),
          },
          calls,
        };
      }

      const completedModelMessages: readonly ModelMessage[] = [
        ...workingMessages,
        { role: 'assistant', content: result.content },
      ];
      return {
        kind: 'completed',
        state: {
          ...state,
          modelMessages: completedModelMessages,
          usageAccounting,
          usage: turnUsage,
          contextAccounting: accountingResult.snapshot,
          ...(accumulatedCompactions.length > 0
            ? { midTurnCompactions: accumulatedCompactions }
            : {}),
        },
        output: result.content,
      };
    },
    applyToolResults(state, executions) {
      return {
        ...state,
        modelMessages: [
          ...state.modelMessages,
          ...executions.map((execution) => ({
            role: 'tool' as const,
            toolCallId: execution.call.toolCallId,
            content: executionContent(execution.result, state.conversationId),
          })),
        ],
        toolExecutions: [
          ...state.toolExecutions,
          ...executions.map((execution) => execution.result),
        ],
        pendingToolCalls: undefined,
      };
    },
  };
}

export function createUnavailableChatModel(message: string): ChatModelPort {
  return {
    initialize(input): ChatModelState {
      const userContent = toUserModelContent(input.input.content, input.input.images);
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
          },
        ],
        modelMessages: [
          ...input.input.modelMessages,
          { role: 'user', content: userContent },
        ],
        toolExecutions: [],
      };
    },
    runTurn(state, context) {
      const streamId = context.run.streamId ?? 'tui-chat';
      context.emit({ type: 'message.delta', streamId, content: message });
      return {
        kind: 'completed',
        state: {
          ...state,
          modelMessages: [...state.modelMessages, { role: 'assistant', content: message }],
        },
        output: message,
      };
    },
    applyToolResults(state) {
      return state;
    },
  };
}
