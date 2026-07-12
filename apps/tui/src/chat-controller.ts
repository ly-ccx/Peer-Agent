import type { ModelMessage, ModelToolCall, ModelUsage } from '@peer-agent/runtime-node';
import {
  createRuntimePipeline,
  type RuntimePipelineModelAdapter,
  type RuntimePipelineToolCall,
  type RuntimeSdkProviderExecution,
} from '@peer-agent/runtime-sdk';

import type { TuiHost } from './tui-host.ts';

export type ChatRole = 'user' | 'assistant' | 'tool';
export type ChatRunStatus = 'idle' | 'running' | 'cancelling';

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  readonly content: string;
  readonly pending?: boolean;
}

export interface ChatSnapshot {
  readonly status: ChatRunStatus;
  readonly messages: readonly ChatMessage[];
  readonly usage?: ModelUsage;
  readonly error?: string;
}

export interface ChatModelToolCall extends RuntimePipelineToolCall {
  readonly capabilityId: string;
  readonly arguments: Record<string, unknown>;
}

export interface ChatModelInput {
  readonly content: string;
  readonly history: readonly ChatMessage[];
  readonly modelMessages: readonly ModelMessage[];
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

export interface ChatController {
  getSnapshot(): ChatSnapshot;
  subscribe(listener: (snapshot: ChatSnapshot) => void): () => void;
  send(content: string): Promise<void>;
  cancel(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createChatController(options: {
  readonly host: TuiHost;
  readonly model: ChatModelPort;
  readonly sessionId?: string;
}): ChatController {
  const listeners = new Set<(snapshot: ChatSnapshot) => void>();
  let snapshot: ChatSnapshot = { status: 'idle', messages: [] };
  let abortController: AbortController | null = null;
  let conversationModelMessages: readonly ModelMessage[] = [];
  let sequence = 0;

  const publish = (next: ChatSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(snapshot);
  };

  const pipeline = createRuntimePipeline<
    ChatModelInput,
    ChatModelState,
    ChatModelToolCall,
    RuntimeSdkProviderExecution,
    string
  >({
    model: options.model,
    tools: {
      async execute(call) {
        const execution = await options.host.execute(call.capabilityId, call.arguments);
        publish({
          ...snapshot,
          messages: [
            ...snapshot.messages,
            {
              id: `tool-${++sequence}`,
              role: 'tool',
              content: `${call.capabilityId}: ${execution.result.outputPreview ?? execution.result.status}`,
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
    async send(content) {
      const trimmed = content.trim();
      if (!trimmed || abortController) return;

      abortController = new AbortController();
      const history = snapshot.messages.filter((message) => !message.pending);
      publish({
        status: 'running',
        messages: [
          ...history,
          { id: `user-${++sequence}`, role: 'user', content: trimmed },
        ],
      });

      try {
        const result = await pipeline.run(
          {
            sessionId: options.sessionId ?? 'tui-chat',
            input: {
              content: trimmed,
              history,
              modelMessages: conversationModelMessages,
            },
          },
          { signal: abortController.signal },
        );
        if (result.state) conversationModelMessages = result.state.modelMessages;
        publish({
          status: 'idle',
          usage: result.state?.usage,
          messages: snapshot.messages.map((message) =>
            message.pending ? { ...message, pending: false } : message,
          ),
          error: result.status === 'exhausted' ? 'The model exhausted its turn limit.' : undefined,
        });
      } catch (error) {
        publish({
          status: 'idle',
          messages: snapshot.messages.map((message) =>
            message.pending ? { ...message, pending: false } : message,
          ),
          error: errorMessage(error),
        });
      } finally {
        abortController = null;
      }
    },
    cancel() {
      if (!abortController) return;
      publish({ ...snapshot, status: 'cancelling' });
      abortController.abort();
    },
  };
}

export function createDemoChatModel(): ChatModelPort {
  return {
    initialize(input) {
      return {
        messages: [
          ...input.input.history,
          { id: 'input', role: 'user', content: input.input.content } as ChatMessage,
        ],
        modelMessages: [
          ...input.input.modelMessages,
          { role: 'user', content: input.input.content },
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
        ? `Tool completed: ${state.toolExecutions.at(-1)?.result.outputPreview ?? 'done'}`
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
            content: String(item.result.result.outputPreview ?? item.result.result.status ?? 'completed'),
          })),
        ],
        toolExecutions: [...state.toolExecutions, ...executions.map((item) => item.result)],
      };
    },
  };
}
