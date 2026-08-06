import type {
  AutomationChatProposal,
  AutomationProposalAction,
} from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { projectAutomationChatProposal } from '../../automations/automationChatProposal';
import { scheduleLabel } from '../../automations/automationPresentation';

function workspaceName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function statusLabel(status: AutomationChatProposal['status'], isZh: boolean): string {
  const labels = isZh
    ? {
        proposed: '等待确认',
        creating: '正在创建',
        created: '已创建',
        cancelled: '已取消',
        failed: '创建失败',
      }
    : {
        proposed: 'Ready to confirm',
        creating: 'Creating',
        created: 'Created',
        cancelled: 'Cancelled',
        failed: 'Creation failed',
      };
  return labels[status];
}

function accessLabel(preset: AutomationChatProposal['definition']['grant']['preset'], isZh: boolean): string {
  if (preset === 'observe') return isZh ? '仅观察' : 'Observe only';
  if (preset === 'work_in_workspace') return isZh ? '可在工作区操作' : 'Work in workspace';
  return preset;
}

export function AutomationProposalCard({
  proposal,
  isZh,
  onAction,
}: {
  readonly proposal: AutomationChatProposal;
  readonly isZh: boolean;
  readonly onAction: (action: AutomationProposalAction) => Promise<void>;
}) {
  const [pendingAction, setPendingAction] = useState<AutomationProposalAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const locale = isZh ? 'zh' : 'en';
  const { canAct, isTerminal, hasCreationReceipt, prefersCompact } = projectAutomationChatProposal(proposal);
  // Terminal proposals default to a compact strip so the thread/composer keep the main visual space.
  // Users can expand once to re-read the body / receipt without keeping the full card permanently open.
  const [expanded, setExpanded] = useState(!prefersCompact);
  useEffect(() => {
    setExpanded(!prefersCompact);
  }, [proposal.proposalId, prefersCompact, proposal.status]);

  const compact = prefersCompact && !expanded;
  const workspace = workspaceName(proposal.definition.workspacePath);
  const notifySuccess = proposal.definition.notifications.succeeded;

  const act = async (action: AutomationProposalAction) => {
    if (pendingAction) return;
    setPendingAction(action);
    setActionError(null);
    try {
      await onAction(action);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingAction(null);
    }
  };

  const compactSummary = (() => {
    if (hasCreationReceipt && proposal.receipt) {
      return isZh
        ? `已创建并启用「${proposal.receipt.automationName}」`
        : `Created and enabled “${proposal.receipt.automationName}”`;
    }
    if (proposal.status === 'cancelled') {
      return isZh ? '提案已取消，不会创建自动化' : 'Proposal cancelled — no automation was created';
    }
    return proposal.definition.name;
  })();

  return (
    <section
      className={`automation-proposal-card is-${proposal.status}${compact ? ' is-compact' : ''}${isTerminal ? ' is-terminal' : ''}`}
      aria-label={isZh ? '自动化任务提案' : 'Automation task proposal'}
      data-proposal-id={proposal.proposalId}
      data-compact={compact ? 'true' : 'false'}
    >
      <header className="automation-proposal-card-header">
        <span className="automation-proposal-card-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 8v4l3 2" />
          </svg>
        </span>
        <span className="automation-proposal-card-kicker">{isZh ? '自动化提案' : 'Automation proposal'}</span>
        {compact ? (
          <span className="automation-proposal-card-compact-title" title={proposal.definition.name}>
            {proposal.definition.name}
          </span>
        ) : null}
        <span className="automation-proposal-card-status">{statusLabel(proposal.status, isZh)}</span>
        {isTerminal ? (
          <button
            type="button"
            className="automation-proposal-card-toggle"
            aria-expanded={!compact}
            onClick={() => setExpanded((value) => !value)}
          >
            {compact
              ? (isZh ? '查看详情' : 'Show details')
              : (isZh ? '收起' : 'Collapse')}
          </button>
        ) : null}
      </header>

      {compact ? (
        <div className="automation-proposal-card-compact-body">
          <p className="automation-proposal-card-compact-summary">{compactSummary}</p>
          {hasCreationReceipt && proposal.receipt ? (
            <code className="automation-proposal-card-compact-id">{proposal.receipt.automationId}</code>
          ) : null}
        </div>
      ) : (
        <>
          <div className="automation-proposal-card-body">
            <h3>{proposal.definition.name}</h3>
            <p className="automation-proposal-card-prompt">{proposal.definition.prompt}</p>

            <dl className="automation-proposal-card-facts">
              <div>
                <dt>{isZh ? '计划' : 'Schedule'}</dt>
                <dd>{scheduleLabel(proposal.definition.schedule, locale)} · {proposal.definition.schedule.timezone}</dd>
              </div>
              <div>
                <dt>{isZh ? '工作区' : 'Workspace'}</dt>
                <dd title={proposal.definition.workspacePath}>{workspace}</dd>
              </div>
              <div>
                <dt>{isZh ? '权限' : 'Access'}</dt>
                <dd>{accessLabel(proposal.definition.grant.preset, isZh)}</dd>
              </div>
              <div>
                <dt>{isZh ? '通知' : 'Notify'}</dt>
                <dd>{notifySuccess ? (isZh ? '失败和成功时' : 'On failure and success') : (isZh ? '需要关注或失败时' : 'When attention is needed or on failure')}</dd>
              </div>
            </dl>

            {hasCreationReceipt && proposal.receipt ? (
              <div className="automation-proposal-receipt" role="status">
                <strong>{isZh ? '自动化已创建并启用' : 'Automation created and enabled'}</strong>
                <span>{proposal.receipt.automationName}</span>
                <code>{proposal.receipt.automationId}</code>
              </div>
            ) : null}

            {proposal.status === 'cancelled' ? (
              <p className="automation-proposal-card-note">{isZh ? '这个提案不会创建自动化。你可以随时描述一个新的任务。' : 'This proposal will not create an automation. You can describe a new task at any time.'}</p>
            ) : null}
            {proposal.error || actionError ? (
              <p className="automation-proposal-card-error" role="alert">{actionError ?? proposal.error}</p>
            ) : null}
          </div>

          {canAct ? (
            <footer className="automation-proposal-card-footer">
              <p>{isZh ? '需要修改？直接在下面告诉我调整任务或计划。' : 'Need changes? Tell me below what to adjust in the task or schedule.'}</p>
              <div className="automation-proposal-card-actions">
                <button type="button" className="automation-proposal-secondary" disabled={Boolean(pendingAction)} onClick={() => void act('cancel')}>
                  {pendingAction === 'cancel' ? (isZh ? '取消中…' : 'Cancelling…') : (isZh ? '取消提案' : 'Cancel proposal')}
                </button>
                <button type="button" className="automation-proposal-primary" disabled={Boolean(pendingAction)} onClick={() => void act('confirm')}>
                  {pendingAction === 'confirm'
                    ? (isZh ? '创建中…' : 'Creating…')
                    : proposal.status === 'failed'
                      ? (isZh ? '重试创建' : 'Retry creation')
                      : (isZh ? '确认并创建' : 'Confirm and create')}
                </button>
              </div>
            </footer>
          ) : null}
        </>
      )}
    </section>
  );
}
