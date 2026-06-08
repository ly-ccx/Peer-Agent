import type {
  AuthState,
  ClientToolCall,
} from '@zeus-atlas/protocol';
import { useCallback, useRef } from 'react';
import { denyClientToolCall, runApprovedClientToolCall } from './clientToolExecution';
import { reportClientToolResultToCloud } from './clientToolResultReporter';
import { errorMessage } from './runtimeHelpers';
import { useClientToolRegistry } from './useClientToolRegistry';
import { useLocalProxyPolling } from './useLocalProxyPolling';

interface UseClientToolRuntimeParams {
  readonly authState: AuthState | null;
  readonly canUseCloudChat: boolean;
  readonly conversationId?: number;
  readonly setError: (message: string | null) => void;
}

export function useClientToolRuntime({
  authState,
  canUseCloudChat,
  conversationId,
  setError,
}: UseClientToolRuntimeParams) {
  const {
    clientToolCalls,
    clientToolGrants,
    clientToolResults,
    enqueueClientToolCalls,
    pendingClientToolCalls,
    recordClientToolResult,
    registerClientToolCall,
    removeFromPending,
    resetClientTools,
    updateClientToolResult,
  } = useClientToolRegistry();

  // 统一执行幂等：local.skill.* 自动放行有 SSE 流事件 + HTTP poll 兜底两条触发通道，
  // 且 run-scoped 长流会跨 pause-resume 重推 client_tool_dispatching。各通道自带的去重
  // Set 互不共享、还会随会话切换重置，导致同一 toolCallId 被执行多次。这里以 toolCallId
  // 为准做最终幂等（不随 conversationId 重置），保证一次调用只真正执行一次。
  const executedToolCallIdsRef = useRef<Set<string>>(new Set());

  // M3·G「一直允许」：会话级全局自动放行。
  // 用户点"一直允许"后，本次会话所有后续确认条默认通过、不再展示。
  // 会话级 → conversationId 变化时重置为 false，杜绝跨会话泄漏。
  const alwaysAllowAllRef = useRef<boolean>(false);
  const alwaysAllowedConversationRef = useRef<number | undefined>(conversationId);
  if (alwaysAllowedConversationRef.current !== conversationId) {
    alwaysAllowedConversationRef.current = conversationId;
    alwaysAllowAllRef.current = false;
  }

  const isAlwaysAllowed = useCallback(
    (_call: ClientToolCall): boolean => alwaysAllowAllRef.current,
    []
  );
  const markAlwaysAllowed = useCallback((): void => {
    alwaysAllowAllRef.current = true;
  }, []);

  const executeClientToolCall = useCallback(async (call: ClientToolCall) => {
    if (executedToolCallIdsRef.current.has(call.toolCallId)) {
      return;
    }
    executedToolCallIdsRef.current.add(call.toolCallId);
    setError(null);
    registerClientToolCall(call);
    removeFromPending(call);
    try {
      const resolution = await runApprovedClientToolCall(call, authState);
      try {
        const result = await reportClientToolResultToCloud({
          call,
          grant: resolution.grant,
          conversationId,
          result: resolution.result,
        });
        recordClientToolResult({ call, grant: resolution.grant, result });
      } catch (nextError) {
        // 回传没送达后端：result 已在手，但后端仍挂在 waiting_user_consent。
        // 回滚幂等标记 + 把授权条重新放回 pending，给用户一个可见的重试入口，
        // 避免永久死锁且无补救（自动放行路径本就不入 pending，否则连入口都没有）。
        executedToolCallIdsRef.current.delete(call.toolCallId);
        enqueueClientToolCalls([call]);
        setError(errorMessage(nextError, 'Evidence 回传云端失败，已恢复授权入口可重试'));
      }
    } catch (execError) {
      // 执行本身异常：回滚登记 + 重新入 pending，既允许重试又保证有可见补救入口
      executedToolCallIdsRef.current.delete(call.toolCallId);
      enqueueClientToolCalls([call]);
      setError(errorMessage(execError, '本地工具执行失败'));
    }
  }, [authState, conversationId, enqueueClientToolCalls, recordClientToolResult, registerClientToolCall, setError]);

  // Polling 路径拿到 local.skill.* 的 toolCall 时需直接执行（不仅 enqueue），
  // 以防 SSE 路径由于 HMR/争抢序未能触发执行，造成 skill 不设行。
  const enqueueClientToolCallsWithAutoExecute = useCallback((calls: readonly ClientToolCall[]) => {
    if (calls.length === 0) return;
    enqueueClientToolCalls(calls);
    for (const call of calls) {
      if (call.capabilityId.startsWith('local.skill.')) {
        console.log('[Step3.5 Polling 路径静默自动放行] capabilityId:', call.capabilityId, 'toolCallId:', call.toolCallId);
        void executeClientToolCall(call);
      }
    }
  }, [enqueueClientToolCalls, executeClientToolCall]);

  const {
    localProxyPolling,
    localProxyStatus,
    pollClientToolCalls,
    startLocalProxyPolling,
    stopLocalProxyPolling,
  } = useLocalProxyPolling({
    canUseCloudChat,
    conversationId,
    enqueueClientToolCalls: enqueueClientToolCallsWithAutoExecute,
  });

  const rejectClientToolCall = useCallback(async (call: ClientToolCall) => {
    setError(null);
    registerClientToolCall(call);
    const resolution = await denyClientToolCall(call, authState);
    let result = resolution.result;
    try {
      result = await reportClientToolResultToCloud({
        call,
        grant: resolution.grant,
        conversationId,
        result: resolution.result,
      });
    } catch (nextError) {
      setError(errorMessage(nextError, 'Evidence 回传云端失败'));
    }

    recordClientToolResult({ call, grant: resolution.grant, result });
  }, [authState, conversationId, recordClientToolResult, registerClientToolCall, setError]);

  const returnClientToolEvidence = useCallback(async (call: ClientToolCall) => {
    const result = clientToolResults[call.toolCallId];
    const grant = clientToolGrants[call.toolCallId];
    if (!result || !grant || result.evidence.returnedToCloud) return;

    setError(null);
    try {
      const cloudResult = await reportClientToolResultToCloud({
        call,
        grant,
        conversationId,
        result,
      });
      updateClientToolResult(call.toolCallId, cloudResult);
    } catch (nextError) {
      setError(errorMessage(nextError, 'Evidence 回传云端失败'));
    }
  }, [clientToolGrants, clientToolResults, conversationId, setError, updateClientToolResult]);

  return {
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
  };
}
