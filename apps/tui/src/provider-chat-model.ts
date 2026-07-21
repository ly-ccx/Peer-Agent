import type { RuntimeToolDefinition } from '@peer-agent/runtime-core';
import type {
  ModelContentPart,
  ModelMessage,
  ModelProvider,
  ModelReasoningEffort,
  ModelToolCall,
  ModelToolDefinition,
} from '@peer-agent/runtime-node';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import type {
  ChatMessage,
  ChatMessageImage,
  ChatModelPort,
  ChatModelState,
  ChatModelToolCall,
} from './chat-controller.ts';
import { normalizeTuiMode, type TuiMode } from './tui-mode.ts';

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
  readonly toolDefinitionsForMode?: (mode: TuiMode) => readonly RuntimeToolDefinition[];
  readonly systemPrompt?: string;
  readonly getSystemPrompt?: () => string;
  readonly getModel?: () => string;
  readonly getReasoningEffort?: () => ModelReasoningEffort;
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

function executionContent(execution: RuntimeSdkProviderExecution): string {
  const result = execution.result;
  const view = {
    status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.outputPreview === undefined ? {} : { outputPreview: result.outputPreview }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
  return JSON.stringify(view);
}

export function createProviderChatModel(options: CreateProviderChatModelOptions): ChatModelPort {
  const defaultToolDefinitions = options.toolDefinitions ?? [];
  const toolDefinitionsForMode = (mode: TuiMode) =>
    options.toolDefinitionsForMode?.(mode) ?? defaultToolDefinitions;

  return {
    initialize(input, context) {
      const mode = normalizeTuiMode(context.run.mode);
      const baseSystemPrompt = options.getSystemPrompt?.() ?? options.systemPrompt;
      const modePrompt =
        mode === 'plan'
          ? PLAN_MODE_SYSTEM_PROMPT
          : mode === 'goal'
            ? GOAL_MODE_SYSTEM_PROMPT
            : null;
      const systemPrompts = [baseSystemPrompt, modePrompt]
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
      };
    },
    async runTurn(state, context) {
      const mode = normalizeTuiMode(context.run.mode);
      const projectedToolDefinitions = toolDefinitionsForMode(mode);
      const toolsByName = new Map(projectedToolDefinitions.map((tool) => [tool.name, tool]));
      const tools = projectedToolDefinitions.map(toModelTool);
      const streamId = context.run.streamId ?? 'tui-chat';
      const reasoningEffort = options.getReasoningEffort?.();
      const result = await (options.getProvider?.() ?? options.provider).stream({
        model: options.getModel?.() ?? options.model,
        messages: state.modelMessages,
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
              ...state.modelMessages,
              { role: 'assistant', content: result.content || null, toolCalls: result.toolCalls },
            ],
            pendingToolCalls: result.toolCalls,
            usage: result.usage,
          },
          calls,
        };
      }

      return {
        kind: 'completed',
        state: {
          ...state,
          modelMessages: [
            ...state.modelMessages,
            { role: 'assistant', content: result.content },
          ],
          usage: result.usage,
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
            content: executionContent(execution.result),
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
