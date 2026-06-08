import type {
  ClientToolCall,
  ClientToolResult,
  PermissionGrant,
} from '@zeus-atlas/protocol';
import { useCallback, useState } from 'react';

interface RecordClientToolResultParams {
  readonly call: ClientToolCall;
  readonly grant: PermissionGrant;
  readonly result: ClientToolResult;
}

export function useClientToolRegistry() {
  const [pendingClientToolCalls, setPendingClientToolCalls] = useState<readonly ClientToolCall[]>([]);
  const [clientToolCalls, setClientToolCalls] = useState<Record<string, ClientToolCall>>({});
  const [clientToolResults, setClientToolResults] = useState<Record<string, ClientToolResult>>({});
  const [clientToolGrants, setClientToolGrants] = useState<Record<string, PermissionGrant>>({});

  const resetClientTools = useCallback(() => {
    setPendingClientToolCalls([]);
    setClientToolCalls({});
    setClientToolResults({});
    setClientToolGrants({});
  }, []);

  const registerClientToolCall = useCallback((call: ClientToolCall) => {
    setClientToolCalls((current) => ({
      ...current,
      [call.toolCallId]: call,
    }));
  }, []);

  const enqueueClientToolCalls = useCallback((calls: readonly ClientToolCall[]) => {
    if (calls.length === 0) return;
    console.log('[Step3 enqueueClientToolCalls] 入队待审批:', calls.map(c => ({ toolCallId: c.toolCallId, capabilityId: c.capabilityId })));
    setClientToolCalls((current) => {
      const next = { ...current };
      for (const call of calls) {
        next[call.toolCallId] = call;
      }
      return next;
    });
    // local.skill.* 静默自动放行：保留到 clientToolCalls 供查询元数据，
    // 但不入 pendingClientToolCalls，避免 PermissionGateStrip 渲染确认条。
    const callsRequiringApproval = calls.filter((call) => !call.capabilityId.startsWith('local.skill.'));
    if (callsRequiringApproval.length === 0) {
      console.log('[Step3 enqueueClientToolCalls] 全部为 local.skill.*，跳过 pending 队列');
      return;
    }
    setPendingClientToolCalls((current) => {
      const existingIds = new Set(current.map((call) => call.toolCallId));
      const next = [...current];
      for (const call of callsRequiringApproval) {
        if (!existingIds.has(call.toolCallId)) {
          next.push(call);
          existingIds.add(call.toolCallId);
        }
      }
      return next;
    });
  }, []);

  const recordClientToolResult = useCallback(({ call, grant, result }: RecordClientToolResultParams) => {
    setClientToolGrants((current) => ({
      ...current,
      [call.toolCallId]: grant,
    }));
    setClientToolResults((current) => ({
      ...current,
      [call.toolCallId]: result,
    }));
    setPendingClientToolCalls((current) => current.filter((item) => item.toolCallId !== call.toolCallId));
  }, []);

  const updateClientToolResult = useCallback((toolCallId: string, result: ClientToolResult) => {
    setClientToolResults((current) => ({
      ...current,
      [toolCallId]: result,
    }));
  }, []);

  const removeFromPending = useCallback((call: ClientToolCall) => {
    setPendingClientToolCalls((current) =>
      current.filter((item) => item.toolCallId !== call.toolCallId)
    );
  }, []);

  return {
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
  };
}
