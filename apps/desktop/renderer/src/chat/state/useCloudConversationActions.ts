import {
  createInitialChatRuntimeState,
  reduceChatRuntime,
} from '@zeus-atlas/chat-kernel';
import type { ChatRuntimeState, Conversation } from '@zeus-atlas/protocol';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { chatClient } from '../api/chatClient';
import { DEFAULT_CEO_AGENT_ID } from './defaultCloudAgent';
import { errorMessage, resolveConversationView } from './runtimeHelpers';

// 切会话前必须先 abort 当前 stream,否则 backend 还在跑,SSE 尾巴会被错误归属
// 到新会话。abort 后 main 端会发 stream:done,renderer 那边靠 streamId+conversationId
// 双重校验把它 ignore 掉。abort 失败不阻塞主流程——最坏情况就是退回到老 bug,
// 不能因此卡住会话切换。
async function abortActiveStreamIfAny(
  activeStreamIdRef: MutableRefObject<string | null>,
  activeStreamConversationIdRef: MutableRefObject<number | null>,
) {
  const streamId = activeStreamIdRef.current;
  activeStreamIdRef.current = null;
  activeStreamConversationIdRef.current = null;
  if (!streamId) return;
  await chatClient.abortMessageStream(streamId).catch(() => undefined);
}

interface UseCloudConversationActionsParams {
  readonly activeAgentId?: number | null;
  readonly activeStreamConversationIdRef: MutableRefObject<number | null>;
  readonly activeStreamIdRef: MutableRefObject<string | null>;
  readonly canUseCloudChat: boolean;
  readonly currentConversation: Conversation | null;
  readonly resetClientTools: () => void;
  readonly setError: Dispatch<SetStateAction<string | null>>;
  readonly setState: Dispatch<SetStateAction<ChatRuntimeState>>;
}

async function loadConversationSnapshot(conversation: Conversation) {
  const [detail, messages] = await Promise.all([
    chatClient.getConversationDetail({ id: conversation.id }),
    chatClient.getMessages({ conversationId: conversation.id, limit: 50, order: 'asc' }),
  ]);
  return { detail, messages };
}

export function useCloudConversationActions({
  activeAgentId,
  activeStreamConversationIdRef,
  activeStreamIdRef,
  canUseCloudChat,
  currentConversation,
  resetClientTools,
  setError,
  setState,
}: UseCloudConversationActionsParams) {
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingConversationId, setLoadingConversationId] = useState<Conversation['id'] | null>(null);
  const selectRequestIdRef = useRef(0);

  const applyLoadedConversation = useCallback(async (conversation: Conversation) => {
    const { detail, messages } = await loadConversationSnapshot(conversation);
    return {
      detail,
      state: reduceChatRuntime(createInitialChatRuntimeState(), {
        type: 'history_loaded',
        conversation: detail,
        view: resolveConversationView(detail),
        messages: messages.list,
      }),
    };
  }, []);

  const refreshConversations = useCallback(async () => {
    if (!canUseCloudChat) return;
    setLoading(true);
    setError(null);
    try {
      // limit 拉大避免"前 50 条窗口"挤出最旧 web 会话——SidebarChannels 的
      // 计数是 conversations 数组本身的统计，limit=50 时新建一条 web 必然挤出
      // 一条最旧 web，count.web 永远不变。500 在大多数活跃用户场景能覆盖。
      const data = await chatClient.listConversations({
        agentId: activeAgentId ?? DEFAULT_CEO_AGENT_ID,
        limit: 500,
        offset: 0,
        status: 'active',
        orderBy: 'gmtModified',
        order: 'desc',
      });
      setConversations(data.list);
    } catch (nextError) {
      setError(errorMessage(nextError, '加载会话失败'));
    } finally {
      setLoading(false);
    }
  }, [canUseCloudChat, setError]);

  const selectConversation = useCallback(async (conversation: Conversation) => {
    const requestId = selectRequestIdRef.current + 1;
    selectRequestIdRef.current = requestId;
    await abortActiveStreamIfAny(activeStreamIdRef, activeStreamConversationIdRef);
    setLoading(true);
    setLoadingConversationId(conversation.id);
    setError(null);
    setState(reduceChatRuntime(createInitialChatRuntimeState(), {
      type: 'conversation_selected',
      conversation,
      view: resolveConversationView(conversation),
      messages: [],
    }));
    resetClientTools();
    try {
      const { detail, state: loadedState } = await applyLoadedConversation(conversation);
      if (selectRequestIdRef.current !== requestId) return;
      setState(loadedState);
      return detail;
    } catch (nextError) {
      if (selectRequestIdRef.current !== requestId) return;
      setError(errorMessage(nextError, '加载会话失败'));
    } finally {
      if (selectRequestIdRef.current === requestId) {
        setLoading(false);
        setLoadingConversationId(null);
      }
    }
  }, [activeStreamConversationIdRef, activeStreamIdRef, applyLoadedConversation, resetClientTools, setError, setState]);

  // 删单条消息/局部 mutation 后刷新当前 thread:只重拉 messages 走 history_loaded
  // 平滑替换,不像 selectConversation 那样先清空 messages 再亮 loading 骨架屏。
  // 复用 selectRequestIdRef:重载途中若用户切走会话,requestId 失配直接丢弃结果,
  // 不会把旧会话消息塞进新会话。以后端为准——后端没删成功则消息会重新出现。
  const reloadActiveConversation = useCallback(async () => {
    const conversation = currentConversation;
    if (!conversation) return undefined;
    const requestId = selectRequestIdRef.current + 1;
    selectRequestIdRef.current = requestId;
    try {
      const { detail, state: loadedState } = await applyLoadedConversation(conversation);
      if (selectRequestIdRef.current !== requestId) return undefined;
      setState(loadedState);
      return detail;
    } catch (nextError) {
      if (selectRequestIdRef.current !== requestId) return undefined;
      setError(errorMessage(nextError, '刷新消息失败'));
      return undefined;
    }
  }, [applyLoadedConversation, currentConversation, setError, setState]);

  const startNewConversation = useCallback(async () => {
    selectRequestIdRef.current += 1;
    await abortActiveStreamIfAny(activeStreamIdRef, activeStreamConversationIdRef);
    setLoading(false);
    setLoadingConversationId(null);
    setError(null);
    setState(createInitialChatRuntimeState());
    resetClientTools();
  }, [activeStreamConversationIdRef, activeStreamIdRef, resetClientTools, setError, setState]);

  const deleteConversation = useCallback(async (conversation: Conversation) => {
    setLoading(true);
    setError(null);
    try {
      await chatClient.deleteConversation({
        id: conversation.id,
        uuid: conversation.conversationUuid,
      });
      if (currentConversation?.id === conversation.id) {
        selectRequestIdRef.current += 1;
        await abortActiveStreamIfAny(activeStreamIdRef, activeStreamConversationIdRef);
        setLoadingConversationId(null);
        setState(createInitialChatRuntimeState());
        resetClientTools();
      }
      setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
      void refreshConversations();
    } catch (nextError) {
      setError(errorMessage(nextError, '删除会话失败'));
    } finally {
      setLoading(false);
    }
  }, [activeStreamConversationIdRef, activeStreamIdRef, currentConversation?.id, refreshConversations, resetClientTools, setError, setState]);

  const deleteCurrentConversation = useCallback(async () => {
    if (!currentConversation) return;
    await deleteConversation(currentConversation);
  }, [currentConversation, deleteConversation]);

  useEffect(() => {
    if (!canUseCloudChat) return undefined;
    void refreshConversations();
    return undefined;
  }, [canUseCloudChat, refreshConversations]);

  return {
    conversations,
    loading,
    loadingConversationId,
    refreshConversations,
    reloadActiveConversation,
    selectConversation,
    startNewConversation,
    deleteConversation,
    deleteCurrentConversation,
  };
}
