import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentCronSessionRecord, Conversation } from '@zeus-atlas/protocol';
import { AutomationCard } from './AutomationCard';
import { AutomationForm } from './AutomationForm';
import { AutomationStatusTabs } from './AutomationStatusTabs';
import type { AutomationFormValues } from './cronFormValues';
import { defaultFormValues } from './cronFormValues';
import { cronSessionId } from './cronSession';
import { useAutomationConsoleData } from './useAutomationConsoleData';

interface AutomationConsoleProps {
  readonly agentId?: number;
  readonly automationConversations: readonly Conversation[];
}

export function AutomationConsole({
  agentId,
  automationConversations,
}: AutomationConsoleProps) {
  const {
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
  } = useAutomationConsoleData(agentId);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMounted, setDrawerMounted] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (drawerOpen) {
      setDrawerMounted(true);
    } else if (drawerMounted) {
      overlayRef.current?.classList.remove('open');
      drawerRef.current?.classList.remove('open');
      const timer = setTimeout(() => setDrawerMounted(false), 250);
      return () => clearTimeout(timer);
    }
  }, [drawerOpen, drawerMounted]);

  useEffect(() => {
    if (!drawerMounted || !drawerOpen) return;
    const drawer = drawerRef.current;
    const overlay = overlayRef.current;
    if (!drawer || !overlay) return;
    void drawer.offsetHeight;
    drawer.classList.add('open');
    overlay.classList.add('open');
  }, [drawerMounted, drawerOpen]);

  const handleCreate = useCallback(async (values: AutomationFormValues) => {
    const ok = await createSession(values);
    if (ok) setDrawerOpen(false);
  }, [createSession]);

  const handleEdit = useCallback(async (session: AgentCronSessionRecord, values: AutomationFormValues) => {
    const sessionId = cronSessionId(session);
    if (!sessionId) return false;
    const version = Number(session.schedule?.version || 1);
    return updateSession(sessionId, version, values);
  }, [updateSession]);

  return (
    <section className="automation-console">
      <header className="automation-console-header">
        <div>
          <h2>Automation 运行台</h2>
          <p>在任意 chat 里直接对 Agent 说明定时任务，这里集中管理已运行的自动化执行流。</p>
        </div>
        <div className="automation-console-actions">
          <button type="button" disabled={loading} onClick={() => void loadSessions()}>
            刷新
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => setDrawerOpen(true)}
          >
            + 手动创建
          </button>
        </div>
      </header>

      <section className="automation-board">
        <div className="automation-board-head">
          <h3>自动化执行流</h3>
          <AutomationStatusTabs
            active={statusFilter}
            counts={statusCounts}
            onChange={setStatusFilter}
          />
        </div>

        {error ? <p className="running-note">{error}</p> : null}
        {loading ? <p className="empty-inline">正在加载 Automation 任务...</p> : null}
        {!loading && visibleSessions.length === 0 ? <p className="empty-inline">暂无 Automation 任务。</p> : null}

        <div className="automation-card-list">
          {visibleSessions.map((session, index) => {
            const sessionId = cronSessionId(session);
            return (
              <AutomationCard
                key={`${sessionId || 'automation'}-${index}`}
                automationConversations={automationConversations}
                expanded={Boolean(sessionId && expandedSessionId === sessionId)}
                index={index}
                loadingRuns={runsLoadingSessionId === sessionId}
                mutating={mutating}
                onEdit={handleEdit}
                onMutate={(id, action) => void mutateSession(id, action)}
                onRecover={(id) => void recoverOpenRuns(id)}
                onToggleRuns={(nextSession) => void toggleRuns(nextSession)}
                runs={sessionId ? runsBySession[sessionId] : undefined}
                session={session}
              />
            );
          })}
        </div>
      </section>

      {drawerMounted ? (
        <div
          ref={overlayRef}
          className="automation-drawer-overlay"
          onClick={() => setDrawerOpen(false)}
        >
          <aside
            ref={drawerRef}
            className="automation-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="automation-drawer-header">
              <h3>手动创建 Automation</h3>
              <button type="button" className="automation-drawer-close" onClick={() => setDrawerOpen(false)}>
                ×
              </button>
            </header>
            <div className="automation-drawer-body">
              <AutomationForm
                initialValues={defaultFormValues()}
                submitting={mutating}
                submitLabel="创建并启动"
                onSubmit={handleCreate}
                onCancel={() => setDrawerOpen(false)}
              />
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
