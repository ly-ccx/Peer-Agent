import { createUserMessage, reduceChatRuntime } from '@zeus-atlas/chat-kernel';
import type {
  ChatRuntimeState,
  Conversation,
} from '@zeus-atlas/protocol';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useCallback } from 'react';
import { clientApi } from '../../clientApi';
import { chatClient } from '../api/chatClient';
import {
  DEFAULT_CEO_AGENT_CHAT_MODE,
  DEFAULT_CEO_AGENT_ID,
} from './defaultCloudAgent';
import { errorMessage, resolveConversationView, titleFromContent } from './runtimeHelpers';
import { useHumanConfirmationActions } from './useHumanConfirmationActions';

interface UseCloudMessageActionsParams {
  readonly activeAgentId?: number | null;
  readonly activeStreamConversationIdRef: MutableRefObject<number | null>;
  readonly activeStreamIdRef: MutableRefObject<string | null>;
  readonly canUseCloudChat: boolean;
  readonly currentConversation: Conversation | null;
  readonly refreshConversations: () => Promise<void>;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setState: Dispatch<SetStateAction<ChatRuntimeState>>;
  readonly startLocalProxyPolling: () => void;
  readonly stopLocalProxyPolling: () => void;
}

export function useCloudMessageActions({
  activeAgentId,
  activeStreamConversationIdRef,
  activeStreamIdRef,
  canUseCloudChat,
  currentConversation,
  refreshConversations,
  setError,
  setState,
  startLocalProxyPolling,
  stopLocalProxyPolling,
}: UseCloudMessageActionsParams) {
  const resolveConfirmation = useHumanConfirmationActions({ setError, setState });

  const sendMessage = useCallback(async (content: string, images?: string[]) => {
    const trimmed = content.trim();
    if (!trimmed || !canUseCloudChat) return;

    setError(null);
    const conversation =
      currentConversation ??
      await chatClient.createConversation({
        title: titleFromContent(trimmed),
        agentId: activeAgentId ?? DEFAULT_CEO_AGENT_ID,
      });
    const userMessage = createUserMessage({
      id: `user_${Date.now()}`,
      content: trimmed,
    });
    const assistantId = `assistant_${Date.now()}`;

    setState((current) => {
      const withConversation = current.conversation
        ? current
        : reduceChatRuntime(current, {
            type: 'conversation_selected',
            conversation,
            view: resolveConversationView(conversation),
            messages: current.messages,
          });
      return reduceChatRuntime(
        reduceChatRuntime(withConversation, {
          type: 'user_message_submitted',
          message: userMessage,
        }),
        {
          type: 'assistant_stream_started',
          messageId: assistantId,
        },
      );
    });

    try {
      const { streamId } = await chatClient.startMessageStream({
        conversationId: conversation.id,
        content: trimmed,
        messageId: assistantId,
        mode: DEFAULT_CEO_AGENT_CHAT_MODE,
        ...(images && images.length > 0 ? { images } : {}),
      });
      activeStreamIdRef.current = streamId;
      // 记下这条 stream 起源的 conversationId,SSE handler 用它交叉校验。
      // 切会话时这两个 ref 一起被清,即使 backend 的尾巴 event 漏过 streamId
      // 校验,这一道也能把它挡在新会话外。
      activeStreamConversationIdRef.current = conversation.id;
      startLocalProxyPolling();
      await refreshConversations();
    } catch (nextError) {
      setState((current) =>
        reduceChatRuntime(current, {
          type: 'stream_error',
          error: errorMessage(nextError, '发送消息失败'),
        }),
      );
    }
  }, [
    activeStreamConversationIdRef,
    activeStreamIdRef,
    canUseCloudChat,
    currentConversation,
    refreshConversations,
    setError,
    setState,
    startLocalProxyPolling,
  ]);

  const stopStream = useCallback(async () => {
    const streamId = activeStreamIdRef.current;
    await clientApi.stopActiveShellTask().catch(() => undefined);
    stopLocalProxyPolling();
    if (!streamId) return;
    // 不在这里清 ref 也不 dispatch stream_cancelled：
    //  - 清 ref 会让 abort 触发的 chat:stream:done 在 renderer 被 isStaleStreamPayload
    //    判 stale 提前 return，连带 reconcile 兜底也吞掉，UI 永久卡在 thinking。
    //  - dispatch stream_cancelled 会清 currentAssistantMessageId，让 done 路径里
    //    的 reconcile 找不到目标，同样吞掉自愈机会。
    // 一律交给 onStreamDone 收到 main 发的 chat:stream:done 后统一处理：翻 isStreaming、
    // finalize thinking（合成 complete event）、必要时 reconcile messages。
    await chatClient.abortMessageStream(streamId);
  }, [activeStreamIdRef, stopLocalProxyPolling]);

  return {
    sendMessage,
    stopStream,
    resolveConfirmation,
  };
}
