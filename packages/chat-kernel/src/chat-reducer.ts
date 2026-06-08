import type {
  ChatMessage,
  ChatRuntimeState,
  ChatStreamEvent,
  Conversation,
  ConversationView,
  MessageImage,
  MessageReference,
  ResolvedHumanConfirmation,
} from '@zeus-atlas/protocol';
import {
  normalizePendingHumanConfirmation,
  removeResolvedConfirmation,
  replacePendingConfirmation,
} from './confirmation-reducer.ts';
import { applyThinkingEvent } from './thinking-reducer.ts';

export type ChatRuntimeAction =
  | {
      readonly type: 'conversation_selected';
      readonly conversation: Conversation | null;
      readonly view?: ConversationView | null;
      readonly messages?: readonly ChatMessage[];
    }
  | {
      readonly type: 'history_loaded';
      readonly conversation: Conversation;
      readonly view?: ConversationView | null;
      readonly messages: readonly ChatMessage[];
    }
  | {
      readonly type: 'user_message_submitted';
      readonly message: ChatMessage;
    }
  | {
      readonly type: 'assistant_stream_started';
      readonly messageId: string;
      readonly timestamp?: number;
      readonly executionUuid?: string;
    }
  | {
      readonly type: 'stream_event';
      readonly event: ChatStreamEvent;
      readonly receivedAt?: string;
    }
  | {
      readonly type: 'stream_cancelled';
      readonly reason?: string;
    }
  | {
      readonly type: 'stream_error';
      readonly error: string;
    }
  | {
      readonly type: 'confirmation_resolved';
      readonly confirmation: ResolvedHumanConfirmation;
    };

export function createInitialChatRuntimeState(params?: {
  readonly conversation?: Conversation | null;
  readonly view?: ConversationView | null;
  readonly messages?: readonly ChatMessage[];
}): ChatRuntimeState {
  return {
    conversation: params?.conversation ?? null,
    view: params?.view ?? null,
    messages: params?.messages ?? [],
    isStreaming: false,
    pendingConfirmations: [],
  };
}

export function createUserMessage(params: {
  readonly id: string;
  readonly content: string;
  readonly timestamp?: number;
  readonly references?: readonly MessageReference[];
  readonly images?: readonly MessageImage[];
}): ChatMessage {
  return {
    id: params.id,
    role: 'user',
    content: params.content,
    timestamp: params.timestamp ?? Date.now(),
    status: 'done',
    ...(params.references && params.references.length > 0 ? { references: params.references } : {}),
    ...(params.images && params.images.length > 0 ? { images: params.images } : {}),
  };
}

export function createAssistantPlaceholder(params: {
  readonly id: string;
  readonly timestamp?: number;
}): ChatMessage {
  return {
    id: params.id,
    role: 'assistant',
    content: '',
    timestamp: params.timestamp ?? Date.now(),
    status: 'streaming',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(data: unknown, keys: readonly string[]): string | undefined {
  if (typeof data === 'string') return data;
  if (!isRecord(data)) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function readNumber(data: unknown, keys: readonly string[]): number | undefined {
  if (!isRecord(data)) return undefined;
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function extractContent(eventType: string, data: unknown): string {
  if (eventType === 'result' && typeof data === 'string') return data;
  if (
    eventType === 'message_delta' ||
    eventType === 'assistant_delta' ||
    eventType === 'final_output_delta' ||
    eventType === 'content_delta' ||
    eventType === 'role_content_delta'
  ) {
    return readString(data, ['content', 'delta', 'text', 'message', 'result', 'finalOutput']) ?? '';
  }
  if (eventType === 'result') {
    return readString(data, ['content', 'text', 'result', 'finalOutput']) ?? '';
  }
  return '';
}

function recoverContentFromThinkingProcess(message: ChatMessage): string | undefined {
  const iterations = message.thinkingProcess?.iterations;
  if (!Array.isArray(iterations)) return undefined;
  return [...iterations]
    .reverse()
    .find((iteration) => iteration.thinkingContent.trim())
    ?.thinkingContent;
}

function recoverCompletedAssistantContent(message: ChatMessage): ChatMessage {
  if (message.content.trim()) return message;
  const recoveredContent = recoverContentFromThinkingProcess(message);
  return recoveredContent ? { ...message, content: recoveredContent } : message;
}

function updateMessage(
  state: ChatRuntimeState,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
): ChatRuntimeState {
  return {
    ...state,
    messages: state.messages.map((message) =>
      message.id === messageId ? updater(message) : message,
    ),
  };
}

function ensureAssistantMessage(state: ChatRuntimeState): ChatRuntimeState {
  if (state.currentAssistantMessageId) return state;
  const message = createAssistantPlaceholder({ id: `assistant_${Date.now()}` });
  return {
    ...state,
    messages: [...state.messages, message],
    currentAssistantMessageId: message.id,
    isStreaming: true,
  };
}

function applyStreamEvent(state: ChatRuntimeState, event: ChatStreamEvent, receivedAt?: string): ChatRuntimeState {
  // run_started 是 run-scoped SSE 长流的开场信号：把 runId 钉到 state 上供 main
  // 进程在原 SSE 流断后做按 runId 的自动重订阅。不创建 assistant message，不
  // 触发 thinking process —— 后续真实事件再走 ensureAssistantMessage 路径。
  if (event.event === 'run_started') {
    const runId = readString(event.data, ['runId', 'userMessageUuid', 'id']);
    return {
      ...state,
      lastEventAt: receivedAt ?? new Date().toISOString(),
      ...(runId ? { currentRunId: runId } : {}),
    };
  }

  let next = ensureAssistantMessage({ ...state, lastEventAt: receivedAt ?? new Date().toISOString() });
  const assistantId = next.currentAssistantMessageId;
  if (!assistantId) return next;

  const currentAssistantMessage = next.messages.find((message) => message.id === assistantId);
  const eventFeedsThinking = event.event === 'content_delta' || event.event === 'role_content_delta';
  const content = eventFeedsThinking && currentAssistantMessage?.thinkingProcess
    ? ''
    : extractContent(event.event, event.data);
  if (content) {
    next = updateMessage(next, assistantId, (message) => ({
      ...message,
      content: message.content + content,
      status: 'streaming',
    }));
  }

  const thinking = applyThinkingEvent(
    next.messages.find((message) => message.id === assistantId)?.thinkingProcess,
    event.event,
    event.data,
  );
  if (thinking) {
    next = updateMessage(next, assistantId, (message) => ({
      ...message,
      thinkingProcess: thinking,
    }));
  }

  const pending = normalizePendingHumanConfirmation(event.data);
  if (pending) {
    next = {
      ...next,
      pendingConfirmations: replacePendingConfirmation(next.pendingConfirmations, pending),
    };
    next = updateMessage(next, assistantId, (message) => ({
      ...message,
      pendingHumanConfirmation: pending,
      status: 'streaming',
    }));
  }

  if (event.event === 'execution_created') {
    const executionUuid = readString(event.data, ['executionUuid']);
    if (executionUuid) next = { ...next, currentExecutionUuid: executionUuid };
  }

  if (event.event === 'chat_complete') {
    next = updateMessage(next, assistantId, (message) => ({
      ...recoverCompletedAssistantContent(message),
      status: 'done',
      messageUuid: readString(event.data, ['messageUuid', 'uuid']) ?? message.messageUuid,
      rawMessageId: readNumber(event.data, ['messageId', 'id']) ?? message.rawMessageId,
    }));
  }

  if (event.event === 'complete') {
    next = updateMessage(next, assistantId, (message) => ({
      ...recoverCompletedAssistantContent(message),
      status: 'done',
    }));
    next = {
      ...next,
      isStreaming: false,
      currentAssistantMessageId: undefined,
    };
  }

  // run_complete 来自后端 EventForwarder.forwardByRun 的 runId-scoped 长流，
  // 标识整个 run（含跨多轮 pause-resume 的所有 execution）已进入终态。
  // 与一次性 chat round 的 chat_complete/complete 互补：单 round 走 complete，
  // 多 round（带 client tool pause-resume）走 run_complete。少了这个分支会
  // 让 assistant message 永远停在 streaming 显示「正在思考...」。
  if (event.event === 'run_complete') {
    next = updateMessage(next, assistantId, (message) => ({
      ...recoverCompletedAssistantContent(message),
      status: 'done',
    }));
    next = {
      ...next,
      isStreaming: false,
      currentAssistantMessageId: undefined,
    };
  }

  if (event.event === 'error') {
    const error = readString(event.data, ['message', 'error', 'errorMsg']) ?? 'Stream error';
    next = updateMessage(next, assistantId, (message) => ({
      ...message,
      status: 'error',
    }));
    next = {
      ...next,
      isStreaming: false,
      currentAssistantMessageId: undefined,
      error,
    };
  }

  return next;
}

export function reduceChatRuntime(
  state: ChatRuntimeState,
  action: ChatRuntimeAction,
): ChatRuntimeState {
  switch (action.type) {
    case 'conversation_selected':
      return {
        ...createInitialChatRuntimeState({
          conversation: action.conversation,
          view: action.view ?? state.view,
          messages: action.messages ?? [],
        }),
      };

    case 'history_loaded':
      return {
        ...createInitialChatRuntimeState({
          conversation: action.conversation,
          view: action.view ?? state.view,
          messages: action.messages,
        }),
      };

    case 'user_message_submitted':
      return {
        ...state,
        messages: [...state.messages, action.message],
        error: undefined,
      };

    case 'assistant_stream_started':
      return {
        ...state,
        messages: [...state.messages, createAssistantPlaceholder({
          id: action.messageId,
          timestamp: action.timestamp,
        })],
        currentAssistantMessageId: action.messageId,
        currentExecutionUuid: action.executionUuid,
        isStreaming: true,
        error: undefined,
      };

    case 'stream_event':
      return applyStreamEvent(state, action.event, action.receivedAt);

    case 'stream_cancelled':
      if (!state.currentAssistantMessageId) {
        return { ...state, isStreaming: false };
      }
      return updateMessage(
        {
          ...state,
          isStreaming: false,
          currentAssistantMessageId: undefined,
        },
        state.currentAssistantMessageId,
        (message) => ({ ...message, status: 'done' }),
      );

    case 'stream_error':
      if (!state.currentAssistantMessageId) {
        return { ...state, isStreaming: false, error: action.error };
      }
      return updateMessage(
        {
          ...state,
          isStreaming: false,
          currentAssistantMessageId: undefined,
          error: action.error,
        },
        state.currentAssistantMessageId,
        (message) => ({ ...message, status: 'error' }),
      );

    case 'confirmation_resolved':
      return {
        ...state,
        pendingConfirmations: removeResolvedConfirmation(
          state.pendingConfirmations,
          action.confirmation,
        ),
        messages: state.messages.map((message) =>
          message.pendingHumanConfirmation?.confirmationId === action.confirmation.confirmationId
            ? {
                ...message,
                pendingHumanConfirmation: undefined,
                resolvedHumanConfirmation: action.confirmation,
              }
            : message,
        ),
      };

    default:
      return state;
  }
}
