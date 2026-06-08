import {
  createInitialChatRuntimeState,
} from '@zeus-atlas/chat-kernel';
import type {
  AuthState,
  ChatRuntimeState,
  CloudRuntimeState,
} from '@zeus-atlas/protocol';
import { useRef, useState } from 'react';
import {
  isCloudRuntimeUsable,
} from './runtimeHelpers';
import { useClientToolRuntime } from './useClientToolRuntime';
import { useCloudStreamEvents } from './useCloudStreamEvents';
import { useCloudConversationActions } from './useCloudConversationActions';
import { useCloudMessageActions } from './useCloudMessageActions';

export function useCloudChatRuntime(params: {
  readonly authState: AuthState | null;
  readonly cloudRuntime: CloudRuntimeState | null;
  readonly activeAgentId?: number | null;
}) {
  const { authState, cloudRuntime, activeAgentId } = params;
  const canUseCloudChat = authState?.status === 'authenticated' && isCloudRuntimeUsable(cloudRuntime);
  const [state, setState] = useState<ChatRuntimeState>(() => createInitialChatRuntimeState());
  const [error, setError] = useState<string | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  // stream 起源的 conversationId — 防串台第二道防线：
  // 切会话时只清 activeStreamIdRef 不够,abort 前已 enqueue 的 SSE event 仍会到
  // renderer;event handler 这里再交叉校验"stream 的归属 conversation 是不是
  // 当前 conversation",避免把老 stream 的尾巴塞进新会话。
  const activeStreamConversationIdRef = useRef<number | null>(null);
  const {
    clientToolCalls,
    clientToolGrants,
    clientToolResults,
    enqueueClientToolCalls,
    executeClientToolCall,
    isAlwaysAllowed,
    markAlwaysAllowed,
    localProxyPolling,
    localProxyStatus,
    pendingClientToolCalls,
    pollClientToolCalls,
    rejectClientToolCall,
    resetClientTools,
    returnClientToolEvidence,
    startLocalProxyPolling,
    stopLocalProxyPolling,
  } = useClientToolRuntime({
    authState,
    canUseCloudChat,
    conversationId: state.conversation?.id,
    setError,
  });
  const {
    conversations,
    loading,
    loadingConversationId,
    refreshConversations,
    reloadActiveConversation,
    selectConversation,
    startNewConversation,
    deleteConversation,
    deleteCurrentConversation,
  } = useCloudConversationActions({
    activeAgentId,
    activeStreamConversationIdRef,
    activeStreamIdRef,
    canUseCloudChat,
    currentConversation: state.conversation,
    resetClientTools,
    setError,
    setState,
  });
  const {
    sendMessage,
    stopStream,
    resolveConfirmation,
  } = useCloudMessageActions({
    activeAgentId,
    activeStreamConversationIdRef,
    activeStreamIdRef,
    canUseCloudChat,
    currentConversation: state.conversation,
    refreshConversations,
    setError,
    setState,
    startLocalProxyPolling,
    stopLocalProxyPolling,
  });

  useCloudStreamEvents({
    activeStreamConversationIdRef,
    activeStreamIdRef,
    currentConversation: state.conversation,
    enqueueClientToolCalls,
    executeClientToolCall,
    isAlwaysAllowed,
    refreshConversations,
    setState,
    stopLocalProxyPolling,
  });

  return {
    canUseCloudChat,
    localProxyPolling,
    localProxyStatus,
    conversations,
    error,
    loading,
    loadingConversationId,
    refreshConversations,
    reloadActiveConversation,
    pollClientToolCalls,
    startLocalProxyPolling,
    stopLocalProxyPolling,
    selectConversation,
    clientToolCalls,
    clientToolGrants,
    pendingClientToolCalls,
    clientToolResults,
    deleteConversation,
    deleteCurrentConversation,
    executeClientToolCall,
    markAlwaysAllowed,
    returnClientToolEvidence,
    rejectClientToolCall,
    sendMessage,
    startNewConversation,
    state,
    stopStream,
    resolveConfirmation,
  };
}
