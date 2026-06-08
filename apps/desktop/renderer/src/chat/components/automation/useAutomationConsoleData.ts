import type { AgentCronRunRecord, AgentCronSessionRecord } from '@zeus-atlas/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { chatClient } from '../../api/chatClient';
import {
  type AutomationStatusFilter,
  cronSessionId,
  cronStatusBucket,
} from './cronSession';
import type { AutomationFormValues } from './cronFormValues';
import {
  buildDeliveryConfig,
  buildTaskTemplateJson,
  resolveCompletionPolicy,
  resolveTrigger,
} from './cronFormValues';

export function useAutomationConsoleData(agentId?: number) {
  const [sessions, setSessions] = useState<readonly AgentCronSessionRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState<AutomationStatusFilter>('all');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [runsBySession, setRunsBySession] = useState<Record<string, readonly AgentCronRunRecord[]>>({});
  const [loading, setLoading] = useState(false);
  const [runsLoadingSessionId, setRunsLoadingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await chatClient.listAgentCronSessions({
        limit: 50,
      });
      const items = data.items ?? data.list ?? [];
      const detailResults = await Promise.allSettled(
        items.map((session) => {
          const sessionId = cronSessionId(session);
          return sessionId
            ? chatClient.getAgentCronSessionDetail({ sessionId, recentRunLimit: 0 })
            : Promise.resolve(session);
        }),
      );
      setSessions(items.map((session, index) => {
        const detailResult = detailResults[index];
        return detailResult?.status === 'fulfilled' ? { ...session, ...detailResult.value } : session;
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '加载 Automation 运行台失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setExpandedSessionId(null);
    setRunsBySession({});
    void loadSessions();
  }, [loadSessions]);

  const statusCounts = useMemo(() => {
    const counts: Record<AutomationStatusFilter, number> = {
      running: 0,
      paused: 0,
      ended: 0,
      all: sessions.length,
    };
    sessions.forEach((session) => {
      const bucket = cronStatusBucket(session);
      if (bucket !== 'all') counts[bucket] += 1;
    });
    return counts;
  }, [sessions]);

  const visibleSessions = useMemo(() => {
    return statusFilter === 'all'
      ? sessions
      : sessions.filter((session) => cronStatusBucket(session) === statusFilter);
  }, [sessions, statusFilter]);

  const toggleRuns = useCallback(async (session: AgentCronSessionRecord) => {
    const sessionId = cronSessionId(session);
    if (!sessionId) return;
    if (expandedSessionId === sessionId) {
      setExpandedSessionId(null);
      return;
    }
    setExpandedSessionId(sessionId);
    if (runsBySession[sessionId]) return;
    setRunsLoadingSessionId(sessionId);
    setError(null);
    try {
      const data = await chatClient.listAgentCronRuns({
        sessionId,
        limit: 8,
      });
      setRunsBySession((current) => ({
        ...current,
        [sessionId]: data.items ?? data.list ?? [],
      }));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '加载执行流水失败');
    } finally {
      setRunsLoadingSessionId(null);
    }
  }, [expandedSessionId, runsBySession]);

  const mutateSession = useCallback(async (sessionId: string, action: 'pause' | 'resume' | 'complete') => {
    setMutating(true);
    setError(null);
    try {
      if (action === 'pause') {
        await chatClient.pauseAgentCronSession({ sessionId });
      } else if (action === 'resume') {
        await chatClient.resumeAgentCronSession({ sessionId });
      } else {
        await chatClient.completeAgentCronSession({ sessionId, reason: 'manual_completed' });
      }
      await loadSessions();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '操作失败');
    } finally {
      setMutating(false);
    }
  }, [loadSessions]);

  const recoverOpenRuns = useCallback(async (sessionId: string) => {
    setMutating(true);
    setError(null);
    try {
      await chatClient.recoverAgentCronSessionOpenRuns({ sessionId, reason: 'manually recovered stuck open run' });
      await loadSessions();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '恢复卡住运行失败');
    } finally {
      setMutating(false);
    }
  }, [loadSessions]);

  const createSession = useCallback(async (values: AutomationFormValues) => {
    if (!agentId) {
      setError('缺少 Agent');
      return false;
    }
    setMutating(true);
    setError(null);
    const trigger = resolveTrigger(values);
    try {
      await chatClient.createAgentCronSession({
        agentId,
        title: values.title,
        triggerType: trigger.triggerType,
        cronExpr: trigger.cronExpr,
        intervalMs: trigger.intervalMs,
        timezone: 'Asia/Shanghai',
        taskTemplateJson: buildTaskTemplateJson(values),
        completionPolicyJson: resolveCompletionPolicy(values),
        deliveryConfigJson: buildDeliveryConfig(values),
      });
      await loadSessions();
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '创建 Automation 失败');
      return false;
    } finally {
      setMutating(false);
    }
  }, [agentId, loadSessions]);

  const updateSession = useCallback(async (sessionId: string, expectedVersion: number, values: AutomationFormValues) => {
    setMutating(true);
    setError(null);
    const trigger = resolveTrigger(values);
    try {
      await chatClient.updateAgentCronSession({
        sessionId,
        expectedVersion,
        title: values.title,
        triggerType: trigger.triggerType,
        cronExpr: trigger.triggerType === 'cron' ? trigger.cronExpr || null : null,
        intervalMs: trigger.triggerType === 'interval' ? trigger.intervalMs || null : null,
        taskTemplateJson: buildTaskTemplateJson(values),
        completionPolicyJson: resolveCompletionPolicy(values),
        deliveryConfigJson: buildDeliveryConfig(values),
      });
      await loadSessions();
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '更新 Automation 失败');
      return false;
    } finally {
      setMutating(false);
    }
  }, [loadSessions]);

  return {
    createSession,
    error,
    expandedSessionId,
    loading,
    loadSessions,
    mutateSession,
    mutating,
    recoverOpenRuns,
    runsBySession,
    runsLoadingSessionId,
    setStatusFilter,
    statusCounts,
    statusFilter,
    toggleRuns,
    updateSession,
    visibleSessions,
  };
}
