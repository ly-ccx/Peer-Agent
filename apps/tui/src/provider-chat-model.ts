import type { RuntimeToolDefinition } from '@peer-agent/runtime-core';
import type {
  ModelMessage,
  ModelProvider,
  ModelToolCall,
  ModelToolDefinition,
} from '@peer-agent/runtime-node';
import type { RuntimeSdkProviderExecution } from '@peer-agent/runtime-sdk';

import type {
  ChatMessage,
  ChatModelPort,
  ChatModelState,
  ChatModelToolCall,
} from './chat-controller.ts';
import { normalizeTuiMode, type TuiMode } from './tui-mode.ts';

export interface CreateProviderChatModelOptions {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly toolDefinitions?: readonly RuntimeToolDefinition[];
  readonly toolDefinitionsForMode?: (mode: TuiMode) => readonly RuntimeToolDefinition[];
  readonly systemPrompt?: string;
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

function parseArguments(call: ModelToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    throw new Error(`Model returned invalid JSON arguments for tool "${call.name}".`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Model returned non-object arguments for tool "${call.name}".`);
  }
  return parsed as Record<string, unknown>;
}

const PLAN_MODE_SYSTEM_PROMPT = `You are in read-only Plan mode. Investigate only with the projected read-only tools. Do not claim to modify files or execute the plan. End with exactly one JSON object (a fenced json block is allowed) using this shape: {"planId":"unique-id","title":"short title","goal":"goal statement","tasks":[{"taskId":"stable-id","title":"one action"}],"successCriteria":[{"description":"verifiable result"}]}. The plan remains a draft until the user chooses Approve and execute.`;

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
      const systemPrompts = [options.systemPrompt, mode === 'plan' ? PLAN_MODE_SYSTEM_PROMPT : null]
        .filter((prompt): prompt is string => Boolean(prompt));
      const modelMessages: ModelMessage[] = [
        ...input.input.modelMessages,
        ...(input.input.modelMessages.length === 0
          ? systemPrompts.map((content) => ({ role: 'system' as const, content }))
          : []),
        { role: 'user', content: input.input.content },
      ];
      return {
        messages: [
          ...input.input.history,
          { id: 'input', role: 'user', content: input.input.content } as ChatMessage,
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
      const result = await options.provider.stream({
        model: options.model,
        messages: state.modelMessages,
        tools,
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
      return {
        messages: [
          ...input.input.history,
          { id: 'input', role: 'user', content: input.input.content },
        ],
        modelMessages: [
          ...input.input.modelMessages,
          { role: 'user', content: input.input.content },
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
