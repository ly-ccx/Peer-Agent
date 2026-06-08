import { useState } from 'react';
import type { AgentCronRunRecord, AgentCronSessionRecord, Conversation } from '@zeus-atlas/protocol';
import { AutomationForm } from './AutomationForm';
import type { AutomationFormValues } from './cronFormValues';
import { inferFormValuesFromSession } from './cronFormValues';
import {
  automationConversationTitle,
  compactSessionCode,
  cronDeliveryLine,
  cronPromptLine,
  cronScheduleLabel,
  cronSessionId,
  cronSessionStatus,
  cronStat,
  cronStatusLabel,
  cronStatusTone,
  cronStopLine,
} from './cronSession';

const terminalStatuses = new Set(['completed', 'archived', 'stopped']);

function AutomationRuns({
  loading,
  runs,
  sessionId,
}: {
  readonly loading: boolean;
  readonly runs: readonly AgentCronRunRecord[] | undefined;
  readonly sessionId: string;
}) {
  return (
    <div className="automation-run-list">
      {loading ? <p className="empty-inline">正在加载执行流水...</p> : null}
      {runs && runs.length === 0 ? <p className="empty-inline">暂无执行流水。</p> : null}
      {runs?.map((run) => (
        <article key={run.runId || `${sessionId}-${run.startedAt ?? run.finishedAt ?? run.status}`}>
          <span className={`automation-status-pill ${cronStatusTone(run.status)}`}>
            {cronStatusLabel(run.status)}
          </span>
          <strong>{run.startedAt ?? run.finishedAt ?? run.runId ?? '-'}</strong>
          <small>{run.errorMsg || run.finishedAt || run.scheduleId || '-'}</small>
        </article>
      ))}
    </div>
  );
}

export function AutomationCard({
  automationConversations,
  expanded,
  index,
  loadingRuns,
  mutating,
  onEdit,
  onMutate,
  onRecover,
  onToggleRuns,
  runs,
  session,
}: {
  readonly automationConversations: readonly Conversation[];
  readonly expanded: boolean;
  readonly index: number;
  readonly loadingRuns: boolean;
  readonly mutating: boolean;
  readonly onEdit: (session: AgentCronSessionRecord, values: AutomationFormValues) => Promise<boolean>;
  readonly onMutate: (sessionId: string, action: 'pause' | 'resume' | 'complete') => void;
  readonly onRecover: (sessionId: string) => void;
  readonly onToggleRuns: (session: AgentCronSessionRecord) => void;
  readonly runs: readonly AgentCronRunRecord[] | undefined;
  readonly session: AgentCronSessionRecord;
}) {
  const [editing, setEditing] = useState(false);

  const sessionId = cronSessionId(session);
  const sessionStatus = cronSessionStatus(session);
  const isFinished = terminalStatuses.has(sessionStatus ?? '');
  const title = automationConversationTitle(session, automationConversations, index);
  const latestRun = session.latestRun;
  const totalRuns = cronStat(session, ['total', 'totalCount', 'runTotal', 'count']);
  const successRuns = cronStat(session, ['success', 'successCount', 'succeeded', 'succeededCount']);
  const failedRuns = cronStat(session, ['failed', 'failedCount', 'failure', 'failureCount']);
  const skippedRuns = cronStat(session, ['skipped', 'skippedCount']);
  const runningRuns = cronStat(session, ['running', 'runningCount', 'pending', 'pendingCount']);
  const hasOpenRuns = runningRuns > 0;

  const handleEdit = async (values: AutomationFormValues) => {
    if (!sessionId) return;
    const ok = await onEdit(session, values);
    if (ok) setEditing(false);
  };

  return (
    <article className="automation-card">
      <header>
        <div className="automation-title-line">
          <h3>{title}</h3>
          <span className={`automation-status-pill ${cronStatusTone(sessionStatus)}`}>
            {cronStatusLabel(sessionStatus)}
          </span>
          {sessionId ? <code>{compactSessionCode(sessionId)}</code> : null}
        </div>
        {!isFinished && sessionId ? (
          <div className="automation-card-actions">
            <button type="button" disabled={mutating} onClick={() => setEditing((v) => !v)}>
              {editing ? '取消编辑' : '编辑'}
            </button>
            {sessionStatus === 'active' || sessionStatus === 'running' ? (
              <button type="button" disabled={mutating} onClick={() => onMutate(sessionId, 'pause')}>暂停</button>
            ) : sessionStatus === 'paused' ? (
              <button type="button" disabled={mutating} onClick={() => onMutate(sessionId, 'resume')}>恢复</button>
            ) : null}
            {hasOpenRuns ? (
              <button type="button" disabled={mutating} onClick={() => onRecover(sessionId)}>恢复卡住</button>
            ) : null}
            <button
              type="button"
              className="danger"
              disabled={mutating}
              onClick={() => {
                if (window.confirm('停止后不会继续触发这个 Automation，确认停止？')) {
                  onMutate(sessionId, 'complete');
                }
              }}
            >
              停止
            </button>
          </div>
        ) : null}
      </header>

      {editing ? (
        <AutomationForm
          initialValues={inferFormValuesFromSession(session)}
          submitting={mutating}
          submitLabel="保存修改"
          onSubmit={handleEdit}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <p className="automation-task-prompt">{cronPromptLine(session)}</p>

          <div className="automation-metrics">
            <div>
              <span>执行策略</span>
              <strong>{cronScheduleLabel(session)}</strong>
            </div>
            <div>
              <span>停止条件</span>
              <strong>{cronStopLine(session)}</strong>
            </div>
            <div>
              <span>下次</span>
              <strong>{session.schedule?.nextRunAt ?? '-'}</strong>
            </div>
            <div>
              <span>最近</span>
              <strong className={`automation-inline-status ${cronStatusTone(latestRun?.status ?? sessionStatus)}`}>
                {cronStatusLabel(latestRun?.status ?? sessionStatus)}
              </strong>
            </div>
            <div>
              <span>发送</span>
              <strong>{cronDeliveryLine(session)}</strong>
            </div>
          </div>
        </>
      )}

      <footer className="automation-card-footer">
        <div className="automation-stats">
          <strong>{totalRuns} 总计</strong>
          <span className="success">{successRuns} 成功</span>
          <span className="danger">{failedRuns} 失败</span>
          <span>{skippedRuns} 跳过</span>
          <span>{runningRuns} 进行中</span>
        </div>
        {sessionId ? (
          <button type="button" onClick={() => onToggleRuns(session)}>
            {expanded ? '收起执行流水' : '展开执行流水'}
          </button>
        ) : null}
      </footer>

      {expanded && sessionId ? (
        <AutomationRuns loading={loadingRuns} runs={runs} sessionId={sessionId} />
      ) : null}
    </article>
  );
}
