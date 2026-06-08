import type { ClientToolCall } from '@zeus-atlas/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clientApi } from '../../clientApi';
import { chatClient } from '../api/chatClient';
import { errorMessage, isMissingEndpointError } from './runtimeHelpers';

interface UseLocalProxyPollingParams {
  readonly canUseCloudChat: boolean;
  readonly conversationId?: number;
  readonly enqueueClientToolCalls: (calls: readonly ClientToolCall[]) => void;
}

export function useLocalProxyPolling({
  canUseCloudChat,
  conversationId,
  enqueueClientToolCalls,
}: UseLocalProxyPollingParams) {
  const [localProxyPolling, setLocalProxyPolling] = useState(false);
  const [localProxyCursor, setLocalProxyCursor] = useState<string | undefined>();
  const [localProxyStatus, setLocalProxyStatus] = useState<string | null>(null);
  // 防重复处理：云端 polling 有时会重复返回已处理过的 toolCallId，
  // 这里维护一个本地 Set过滤。
  const processedToolCallIdsRef = useRef<Set<string>>(new Set());

  const pollClientToolCalls = useCallback(async () => {
    if (!canUseCloudChat) return;
    try {
      const session = await clientApi.getClientSession();
      const data = await chatClient.pollClientToolCalls({
        sessionId: session.sessionId,
        conversationId,
        cursor: localProxyCursor,
        limit: 5,
        polledAt: new Date().toISOString(),
      });
      setLocalProxyCursor(data.cursor);
      // 过滤掉本地已处理过的 toolCallId，避免重复执行
      const freshCalls = data.calls.filter((call) => {
        if (processedToolCallIdsRef.current.has(call.toolCallId)) {
          return false;
        }
        return true;
      });
      // 在入队之前先记录到 processed Set，后续轮询不会再重复出现
      for (const call of freshCalls) {
        processedToolCallIdsRef.current.add(call.toolCallId);
      }
      if (freshCalls.length > 0) {
        enqueueClientToolCalls(freshCalls);
      }
      setLocalProxyStatus(freshCalls.length > 0
        ? `received ${freshCalls.length} client tool call(s)`
        : 'idle');
    } catch (nextError) {
      if (isMissingEndpointError(nextError)) {
        setLocalProxyPolling(false);
        setLocalProxyStatus('client tool poll endpoint unavailable (HTTP 404); polling stopped');
        return;
      }
      setLocalProxyStatus(errorMessage(nextError, '本地代理拉取任务失败'));
    }
  }, [canUseCloudChat, conversationId, enqueueClientToolCalls, localProxyCursor]);

  const startLocalProxyPolling = useCallback(() => {
    setLocalProxyPolling(true);
    void pollClientToolCalls();
  }, [pollClientToolCalls]);

  const stopLocalProxyPolling = useCallback(() => {
    setLocalProxyPolling(false);
  }, []);

  useEffect(() => {
    if (!localProxyPolling) return undefined;
    const timer = window.setInterval(() => {
      void pollClientToolCalls();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [localProxyPolling, pollClientToolCalls]);

  return {
    localProxyPolling,
    localProxyStatus,
    pollClientToolCalls,
    startLocalProxyPolling,
    stopLocalProxyPolling,
  };
}
