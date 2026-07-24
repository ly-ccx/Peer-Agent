import {
  collectToolEvidenceRefs,
  COMPACTION_SUMMARY_PROMPT,
  COMPACTION_SUMMARY_SYSTEM_PROMPT,
  decideContextCompaction,
  isPromptTooLongError,
  microcompactMessagesForContext,
  splitMessagesForCompaction,
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
import { materializeToolResultContent } from '@peer-agent/runtime-node';
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
import { computeNextRequestInputTokens } from './context-pressure.ts';
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
  readonly getSystemPrompt?: () => string;
  readonly getModel?: () => string;
  readonly getReasoningEffort?: () => ModelReasoningEffort;
  readonly getContextWindow?: () => number | undefined;
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

const PLAN_JSON_SHAPE =
  '{"planId":"unique-id","title":"short title","goal":"goal statement","tasks":[{"taskId":"stable-id","title":"one action"}],"successCriteria":[{"description":"verifiable result"}]}';

const PLAN_MODE_SYSTEM_PROMPT = `You are in read-only Plan mode. Investigate only with the projected read-only tools. Do not claim to modify files or execute the plan. End with exactly one JSON object (a fenced json block is allowed) using this shape: ${PLAN_JSON_SHAPE}. The plan remains a draft until the user chooses Approve and execute.`;

// Goal mode must create a plan via goal_create_plan before side-effect tools.
// Intake gate blocks shell/write until a plan exists for this conversation.
const GOAL_MODE_SYSTEM_PROMPT = `You are in Goal mode (self-driven). Before any side-effecting work (bash, write_file, edit_file, etc.), you MUST call the tool goal_create_plan with a clear goal, ordered tasks, and success criteria. Read-only investigation tools and goal_get_plan / goal_update_task are allowed. Do not invent progress: only goal_update_task records task completion. If a plan already exists, use goal_get_plan and continue from it. Prefer goal_create_plan over dumping a free-form JSON plan in the assistant message.`;

function executionContent(execution: RuntimeSdkProviderExecution, conversationId?: string): string {
  const result = execution.result;
  const evidenceRefs = collectToolEvidenceRefs({
    toolCallId: result.toolCallId,
    execution,
  });
  const view = {
    status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.outputPreview === undefined ? {} : { outputPreview: result.outputPreview }),
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(evidenceRefs.length === 0 ? {} : { evidenceRefs }),
  };
  const json = JSON.stringify(view);
  // Layer 0 材料化(与 Desktop tool-orchestrator 同源):超阈值输出落盘 artifact,
  // provider 消息只留 ref 骨架;写盘失败降级为原文,交给共享 microcompact 兜底。
  try {
    return materializeToolResultContent({
      conversationId,
      toolCallId: result.toolCallId,
      tool: 'tool',
      content: json,
      isError: result.status === 'failed',
    }).content;
  } catch {
    return json;
  }
}

function formatSystemContextBlocks(
  blocks: ChatModelInput['systemContextBlocks'],
): string | null {
  if (!blocks || blocks.length === 0) return null;
  const sections = blocks
    .filter((block) => block.content.trim().length > 0)
    .map((block) => `## ${block.title}\n${block.content.trim()}`);
  return sections.length > 0 ? sections.join('\n\n') : null;
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

/**
 * turn 内确定性结构化压缩(21 号文档 13.2 安全边界:仅在下一次 provider 请求前)。
 * 不在 loop 中嵌套 LLM 摘要调用;切分/摘要/handoff 均复用共享实现。
 * 无可压内容时返回 null,由调用方决定继续/抛错。
 */
function compactModelMessagesMidTurn(input: {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly reason: MidTurnCompaction['reason'];
}): { readonly messages: readonly ModelMessage[]; readonly record: MidTurnCompaction } | null {
  const split = splitMessagesForCompaction(input.messages, {
    keepRecentCount: TUI_COMPACT_KEEP_RECENT,
    preserveLatestUserTurn: true,
  });
  if (split.oldMessages.length === 0) return null;
  const beforeTokens = computeNextRequestInputTokens({ messages: input.messages, tools: input.tools });
  const summary = buildStructuralSummary(split.oldMessages as readonly ModelMessage[]);
  const handoffContent = buildHandoffContent(summary, split.oldMessages.length);
  const nextMessages: readonly ModelMessage[] = [
    ...split.systemMessages,
    { role: 'user', content: handoffContent },
    ...split.keepMessages,
  ];
  return {
    messages: nextMessages,
    record: {
      reason: input.reason,
      method: 'structured',
      beforeCount: input.messages.length,
      afterCount: nextMessages.length,
      summarizedCount: split.oldMessages.length,
      beforeTokens,
      afterTokens: computeNextRequestInputTokens({ messages: nextMessages, tools: input.tools }),
      summary,
      handoffContent,
      retainedUserCount: split.keepMessages.filter((message) => message.role === 'user').length,
    },
  };
}

export function createProviderChatModel(options: CreateProviderChatModelOptions): ChatModelPort {
  const defaultToolDefinitions = options.toolDefinitions ?? [];
  const toolDefinitionsForMode = (mode: TuiRuntimeMode) =>
    options.toolDefinitionsForMode?.(mode) ?? defaultToolDefinitions;

  return {
    async summarizeCompaction(input) {
      let streamedChars = 0;
      const result = await streamWithSafeRetry((options.getProvider?.() ?? options.provider), {
        model: options.getModel?.() ?? options.model,
        messages: [
          { role: 'system', content: COMPACTION_SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: input.formattedHistory },
          { role: 'user', content: COMPACTION_SUMMARY_PROMPT },
        ],
        tools: [],
        temperature: 0.2,
        maxOutputTokens: 4096,
        onEvent(event) {
          if (event.type !== 'text.delta') return;
          streamedChars += event.content.length;
          input.onProgress?.(Math.min(95, 10 + Math.floor(streamedChars / 80)));
        },
      });
      input.onProgress?.(100);
      return result.content;
    },
    initialize(input, context) {
      const mode = normalizeTuiRuntimeMode(context.run.mode);
      const baseSystemPrompt = options.getSystemPrompt?.() ?? options.systemPrompt;
      const modePrompt =
        mode === 'plan'
          ? PLAN_MODE_SYSTEM_PROMPT
          : mode === 'goal'
            ? GOAL_MODE_SYSTEM_PROMPT
            : null;
      const turnSystemContext = formatSystemContextBlocks(input.input.systemContextBlocks);
      const systemPrompts = [baseSystemPrompt, modePrompt, turnSystemContext]
        .filter((prompt): prompt is string => Boolean(prompt));
      const userContent = toUserModelContent(input.input.content, input.input.images);
      // Always re-inject mode system prompts so mid-session mode switches
      // (especially Goal intake) take effect on the next turn.
      const historyWithoutModeSystem = input.input.modelMessages.filter((message) => {
        if (message.role !== 'system' || typeof message.content !== 'string') return true;
        return !(
          message.content.includes('You are in Goal mode')
          || message.content.includes('You are in read-only Plan mode')
        );
      });
      const modelMessages: ModelMessage[] = [
        ...systemPrompts.map((content) => ({ role: 'system' as const, content })),
        ...historyWithoutModeSystem,
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
      // Same tools-schema estimate as Desktop computeContextBudget / estimateToolsTokens.
      const contextWindowRaw = Number(options.getContextWindow?.());
      const contextWindow = Number.isFinite(contextWindowRaw) && contextWindowRaw > 0
        ? Math.floor(contextWindowRaw)
        : null;
      const requestProjection = (messages: readonly ModelMessage[]) => ({
        nextRequestInputTokens: computeNextRequestInputTokens({ messages, tools }),
        contextWindow,
        model,
      });

      // 与 Desktop 同语义的 loop 中途 preflight(21 号文档 13.2):每次 provider 请求前
      // 按共享阈值判定;越线则先确定性结构化压缩再发送,不盲发超窗请求。
      // Layer 1(共享 microcompact,与 Desktop 同源):发送切片对历史工具结果证据引用化,
      // state 保留原文(Desktop apiMessages 同构);resume 重建的大 tool detail 在此收敛。
      let workingMessages = state.modelMessages;
      const projectSendMessages = (messages: readonly ModelMessage[]): readonly ModelMessage[] =>
        microcompactMessagesForContext(messages).messages;
      let sendMessages = projectSendMessages(workingMessages);
      const midTurnCompactions: MidTurnCompaction[] = [];
      const preflight = decideContextCompaction({
        pressureTokens: computeNextRequestInputTokens({ messages: sendMessages, tools }),
        contextWindow,
      });
      if (preflight.shouldCompact) {
        const compacted = compactModelMessagesMidTurn({
          messages: workingMessages,
          tools,
          reason: 'preflight',
        });
        if (compacted) {
          workingMessages = compacted.messages;
          midTurnCompactions.push(compacted.record);
          sendMessages = projectSendMessages(workingMessages);
        }
      }

      const sendOnce = () => streamWithSafeRetry((options.getProvider?.() ?? options.provider), {
        model,
        messages: sendMessages,
        tools,
        ...(!reasoningEffort || reasoningEffort === 'default' ? {} : { reasoningEffort }),
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

      let result;
      try {
        result = await sendOnce();
      } catch (error) {
        // PTL emergency 与 Desktop 同策略(分类同源 runtime-core,同一请求最多重试一次):
        // 强制结构化压缩后重发;压不动或非 PTL 错误则原样抛出。
        const text = error instanceof Error ? error.message : String(error);
        if (context.signal?.aborted || !isPromptTooLongError(null, text)) throw error;
        const emergency = compactModelMessagesMidTurn({
          messages: workingMessages,
          tools,
          reason: 'emergency',
        });
        if (!emergency) throw error;
        workingMessages = emergency.messages;
        midTurnCompactions.push(emergency.record);
        sendMessages = projectSendMessages(workingMessages);
        result = await sendOnce();
      }

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
            usage: result.usage,
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
          usage: result.usage,
          // 投影用发送口径(Layer 1 后)切片,与 Desktop computeContextInfo 同成分,
          // 使同一会话两端占用收敛。
          requestProjection: requestProjection(projectSendMessages(completedModelMessages)),
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
