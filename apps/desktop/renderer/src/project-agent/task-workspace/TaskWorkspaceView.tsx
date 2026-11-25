import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile, InputDraftTaskRef } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { useCompositionGuard } from '../../app/hooks/useCompositionGuard';
import { BotAvatar } from '../BotAvatar';
import { BotAccessControl } from '../BotAccessControl';
import { formatDrawerSessionStatus, formatDrawerStamp, type DrawerSession } from '../state/drawerState';
import { mergeTaskDetail, taskProgressPreview } from '../state/taskDetailState';
import { useTaskReport } from '../state/useTaskReport';
import { useTaskCancellation } from '../state/TaskCancellation';
import type { TaskConversationContext } from '../state/taskConversationState';
import { ComposerTouchBar } from '../conversation/ComposerTouchBar';
import { ConversationSceneDrawer } from '../drawer/ConversationScene';
import { TaskEvidenceInspector, type InspectorTab } from './TaskEvidenceInspector';
import '../styles/bot-task-workspace.css';
import '../styles/bot-touchbar.css';

interface PendingTaskApproval {
  readonly approvalId: string;
  readonly summary?: string;
  readonly capabilityId?: string;
  readonly sessionId?: string;
  readonly planId?: string;
  readonly state?: string;
}

export interface TaskWorkspaceViewProps {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly profile: BotProfile;
  readonly sessionId: string;
  readonly liveSession: DrawerSession | null;
  readonly sessionsAvailable: boolean;
  readonly context: TaskConversationContext | null;
  readonly inspectorOpen: boolean;
  readonly inspectorTriggerRef: React.RefObject<HTMLElement | null>;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onToggleInspector: () => void;
  readonly onCloseInspector: () => void;
  readonly onBackToBot: (focusMessageId?: string) => void;
  readonly onOpenTask: (sessionId: string) => void;
  readonly onCiteToBot: (ref: InputDraftTaskRef, prefillText?: string) => void;
  readonly onRefreshSessions: () => Promise<void>;
  readonly onEvidenceCountChange?: (count: number) => void;
}

const INSPECTOR_PUSH_MIN = 960;

function formatFailureReason(
  failure: { readonly code: string; readonly message?: string },
  isZh: boolean,
): string {
  const knownZh: Record<string, string> = {
    tool_not_projected: '所需工具能力未投影到该工作会话',
    WORKER_MODEL_UNAVAILABLE: '工作会话执行模型不可用',
    agent_loop_exhausted: '已达到单次执行的最大工具轮次上限',
    model_timeout: '模型响应超时',
    model_transport_failed: '模型网络连接中断',
    model_stream_interrupted: '模型输出流意外中断',
    permission_denied: '操作被权限边界拒绝',
    verifier_timeout: '独立核验超时（5 分钟）',
    verifier_permission_denied: '核验会话触发了只读边界限制',
    verifier_report_invalid: '核验模型未返回合法的结构化核验结论',
    verifier_host_interrupted: '宿主重启导致核验中断',
  };
  const knownEn: Record<string, string> = {
    tool_not_projected: 'Required tool capability was not projected into this work session',
    WORKER_MODEL_UNAVAILABLE: 'Worker model is unavailable',
    agent_loop_exhausted: 'Reached the maximum tool-turn limit for this session',
    model_timeout: 'Model request timed out',
    model_transport_failed: 'Model network connection failed',
    model_stream_interrupted: 'Model response stream was interrupted',
    permission_denied: 'Action denied by permission boundary',
    verifier_timeout: 'Independent verification timed out',
    verifier_permission_denied: 'Verifier attempted an action outside its read-only boundary',
    verifier_report_invalid: 'Verifier did not return a valid structured report',
    verifier_host_interrupted: 'Verification interrupted by host restart',
  };
  const dict = isZh ? knownZh : knownEn;
  if (dict[failure.code]) return dict[failure.code];
  if (failure.message && failure.message !== failure.code) return failure.message;
  return isZh ? `执行中止（${failure.code}）` : `Execution failed (${failure.code})`;
}

export function TaskWorkspaceView({
  workspaceId,
  workspacePath,
  profile,
  sessionId,
  liveSession,
  sessionsAvailable,
  context,
  inspectorOpen,
  inspectorTriggerRef,
  i18n,
  isZh,
  onToggleInspector,
  onCloseInspector,
  onBackToBot,
  onOpenTask,
  onCiteToBot,
  onRefreshSessions,
  onEvidenceCountChange,
}: TaskWorkspaceViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [overlayInspector, setOverlayInspector] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('evidence');
  const [sceneOpen, setSceneOpen] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingTaskApproval | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly text: string; readonly error?: boolean } | null>(null);
  const [followUpText, setFollowUpText] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const composition = useCompositionGuard();
  const cancellation = useTaskCancellation();

  const reportRead = useTaskReport(
    workspaceId,
    sessionId,
    true,
    liveSession?.status,
    sessionsAvailable || !liveSession,
    `${liveSession?.sourceRevision || ''}:${liveSession?.observationRevision || ''}`,
  );
  const session = useMemo(
    () => mergeTaskDetail(liveSession, reportRead.detail),
    [liveSession, reportRead.detail],
  );

  const evidenceCount = useMemo(() => {
    if (!session) return 0;
    return new Set([
      ...session.evidenceRefs,
      ...(session.verification?.checks.flatMap((c) => c.evidenceRefs) ?? []),
      ...(session.verification?.outputs.map((o) => o.evidenceRef) ?? []),
    ]).size;
  }, [session]);

  useEffect(() => {
    onEvidenceCountChange?.(evidenceCount);
  }, [evidenceCount, onEvidenceCountChange]);

  // Measure container width so Inspector degrades smoothly to frosted overlay on narrow windows
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setOverlayInspector(el.clientWidth < INSPECTOR_PUSH_MIN);
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // Reset transient per-task state on session change
  useEffect(() => {
    setSceneOpen(false);
    setFeedback(null);
    setVerifyBusy(false);
    setApprovalBusy(false);
  }, [sessionId]);

  // Load any open pending approval scoped to this task
  const loadApprovals = useCallback(async () => {
    try {
      const res = await clientApi.projectAgentListApprovals({ workspaceId });
      if (!res?.ok || !Array.isArray(res.approvals)) {
        setPendingApproval(null);
        return;
      }
      const match = (res.approvals as PendingTaskApproval[]).find((item) => {
        if (item.state && item.state !== 'open') return false;
        if (item.sessionId && item.sessionId === sessionId) return true;
        if (session?.planId && item.planId && item.planId === session.planId) return true;
        return false;
      });
      setPendingApproval(match ?? null);
    } catch {
      setPendingApproval(null);
    }
  }, [workspaceId, sessionId, session?.planId]);

  useEffect(() => {
    void loadApprovals();
    return clientApi.onProjectAgentChanged((event) => {
      if (!event.workspaceIds?.length || event.workspaceIds.includes(workspaceId)) {
        void loadApprovals();
      }
    });
  }, [loadApprovals, workspaceId]);

  const openInspectorTab = useCallback((tab: InspectorTab) => {
    setInspectorTab(tab);
    if (!inspectorOpen) onToggleInspector();
  }, [inspectorOpen, onToggleInspector]);

  const handleApprovalDecision = useCallback(async (decision: 'approve' | 'reject') => {
    if (!pendingApproval || approvalBusy) return;
    setApprovalBusy(true);
    setFeedback(null);
    try {
      const result = await clientApi.projectAgentDecideApproval({
        workspaceId,
        approvalId: pendingApproval.approvalId,
        decision,
      });
      if (!result?.ok) {
        setFeedback({
          text: isZh ? `提交决定失败（${result?.code || 'FAILED'}）` : `Decision failed (${result?.code || 'FAILED'})`,
          error: true,
        });
      } else {
        setFeedback({
          text: decision === 'approve'
            ? (isZh ? '已批准该计划，宿主已同步状态。' : 'Plan approved and synced with host.')
            : (isZh ? '已拒绝该计划，任务未启动并已记录回执。' : 'Plan rejected; receipt recorded.'),
        });
        await Promise.all([onRefreshSessions(), loadApprovals()]);
        reportRead.refresh();
      }
    } finally {
      setApprovalBusy(false);
    }
  }, [pendingApproval, approvalBusy, workspaceId, isZh, onRefreshSessions, loadApprovals, reportRead]);

  const handleReverify = useCallback(async () => {
    if (verifyBusy) return;
    setVerifyBusy(true);
    setFeedback(null);
    try {
      const res = await clientApi.projectAgentVerifySession({ workspaceId, sessionId });
      if (!res?.ok) {
        const msg = res?.code === 'reverify_limit_exceeded'
          ? (isZh ? '已达到单会话独立核验上限（3/3 次），请在对话中指示下一步。' : 'Verification limit (3/3) reached.')
          : (isZh ? `未能发起独立重验（${res?.code || 'FAILED'}）` : `Re-verification failed (${res?.code || 'FAILED'})`);
        setFeedback({ text: msg, error: true });
      } else {
        setFeedback({
          text: isZh ? '已完成本轮独立只读核验，结果已更新。' : 'Independent verification complete.',
        });
        await onRefreshSessions();
        reportRead.refresh();
      }
    } finally {
      setVerifyBusy(false);
    }
  }, [verifyBusy, workspaceId, sessionId, isZh, onRefreshSessions, reportRead]);

  const handleSendFollowUp = useCallback(async () => {
    const trimmed = followUpText.trim();
    if (!trimmed || sendingFollowUp) return;
    setSendingFollowUp(true);
    setFeedback(null);
    try {
      const answerTo = context?.question?.cardId;
      const result = await clientApi.projectAgentSubmitInput({
        workspaceId,
        inputId: crypto.randomUUID(),
        text: trimmed,
        surface: 'desktop',
        taskRefs: [sessionId],
        ...(answerTo ? { answerTo } : {}),
      });
      if (!result?.ok) {
        setFeedback({
          text: isZh ? `发送失败（${result?.code || 'FAILED'}），原输入已保留。` : `Failed to send (${result?.code || 'FAILED'}).`,
          error: true,
        });
      } else {
        setFollowUpText('');
        setFeedback({
          text: isZh ? `已投递给 ${profile.displayName} 并绑定当前任务上下文。` : `Sent to ${profile.displayName} with task context.`,
        });
      }
    } finally {
      setSendingFollowUp(false);
    }
  }, [followUpText, sendingFollowUp, context?.question?.cardId, workspaceId, sessionId, isZh, profile.displayName]);

  if (!session) {
    return (
      <div className="bot-task-workspace" ref={rootRef}>
        <div className="bot-task-stage">
          <div className="bot-task-scroll">
            <div className="bot-task-column">
              <p className="bot-inspector-empty">
                {reportRead.state === 'loading'
                  ? (isZh ? '正在读取任务现场…' : 'Loading task workspace…')
                  : (isZh ? '暂时无法读取该任务详情。' : 'Task details are unavailable.')}
              </p>
              {reportRead.state === 'unavailable' ? (
                <button type="button" className="bot-task-btn" style={{ alignSelf: 'center' }} onClick={reportRead.refresh}>
                  {i18n.t('projectAgent.background.retry')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const title = session.title && session.title !== session.sessionId
    ? session.title
    : i18n.t('projectAgent.chat.work.related');
  const statusLabel = formatDrawerSessionStatus(session, i18n);
  const progress = taskProgressPreview(session, context, i18n);
  const stamp = formatDrawerStamp(session.spawnedAt);
  const followUp = session.followUp;
  const ended = followUp ? !followUp.inCurrentList : ['accepted', 'cancelled', 'superseded', 'paused'].includes(session.status);
  const tone = pendingApproval || followUp?.owner === 'user'
    ? 'warn'
    : followUp?.reason === 'verification_failed' || session.status === 'failed'
      ? 'danger'
      : ended
        ? (session.status === 'accepted' ? 'good' : 'muted')
        : 'azure';
  const originMessageId = context?.messageId || session.anchorMessageId || undefined;
  const originQuote = context?.content
    ? context.content.replace(/\s+/g, ' ').trim().slice(0, 120)
    : '';
  const cancelState = cancellation?.states[`${workspaceId}:${sessionId}`];

  const taskRefPayload: InputDraftTaskRef = {
    sessionId: session.sessionId,
    title,
    status: session.status,
    anchorMessageId: originMessageId,
  };

  return (
    <div className="bot-task-workspace" ref={rootRef}>
      <div className="bot-task-stage">
        <div className="bot-task-scroll">
          <div className="bot-task-column">
            {/* Origin Link Strip */}
            <button
              type="button"
              className="bot-task-origin"
              onClick={() => onBackToBot(originMessageId)}
            >
              <span className="bot-task-origin-left">
                <BotAvatar
                  avatar={profile.avatar}
                  label={profile.displayName}
                  workspaceId={workspaceId}
                />
                <span className="bot-task-origin-copy">
                  <span className="bot-task-origin-who">
                    {profile.displayName}{stamp ? ` · ${isZh ? `派发于 ${stamp}` : `Spawned ${stamp}`}` : ''}
                  </span>
                  <span className="bot-task-origin-quote">
                    {originQuote
                      ? `「${originQuote}」`
                      : (isZh ? '返回主对话查看上下文（输入草稿保留）' : 'Return to main conversation (draft preserved)')}
                  </span>
                </span>
              </span>
              <span className="bot-task-origin-back">
                <span>{isZh ? '回到主对话' : 'Back to chat'}</span>
                <PeerIcon name="chevronRight" size={13} />
              </span>
            </button>

            {/* Task Hero */}
            <section className="bot-task-hero">
              <div className="bot-task-hero-meta">
                <span className="bot-task-status-pill" data-tone={tone}>
                  <PeerIcon
                    name={tone === 'good' ? 'check' : tone === 'warn' || tone === 'danger' ? 'warning' : tone === 'azure' ? 'loader' : 'circle'}
                    size={12}
                    className={tone === 'azure' && !ended ? 'motion-spin' : undefined}
                  />
                  <span>{statusLabel}</span>
                </span>
                {session.modelLabel ? (
                  <>
                    <span className="bot-task-meta-sep" aria-hidden="true">·</span>
                    <span className="bot-task-meta-text">{session.modelLabel}</span>
                  </>
                ) : null}
                {stamp ? (
                  <>
                    <span className="bot-task-meta-sep" aria-hidden="true">·</span>
                    <span className="bot-task-meta-text">{stamp}</span>
                  </>
                ) : null}
              </div>
              <h1>{title}</h1>
              {progress && progress !== session.status ? (
                <p className="bot-task-hero-progress">{progress}</p>
              ) : null}
            </section>

            {/* Feedback Banner */}
            {feedback ? (
              <p className={`bot-task-feedback${feedback.error ? ' is-error' : ''}`} role={feedback.error ? 'alert' : 'status'}>
                {feedback.text}
              </p>
            ) : null}

            {/* Pending Approval Scope Summary (single primary CTA lives on Touch Bar below) */}
            {pendingApproval ? (
              <section className="bot-task-verdict-banner" aria-label={isZh ? '待批准计划范围' : 'Pending plan approval'}>
                <div className="bot-task-verdict-copy">
                  <strong>{isZh ? '需要你决定：确认是否批准执行该计划' : 'Decision required: approve this plan?'}</strong>
                  <span>
                    {pendingApproval.summary || (isZh ? '请在下方 Touch Bar 选择「拒绝」或「批准计划」，也可先展开右侧边界详情。' : 'Approve or reject on the Touch Bar below, or inspect scope details.')}
                  </span>
                </div>
                <button type="button" className="bot-task-btn" onClick={() => openInspectorTab('coordination')}>
                  {isZh ? '核查边界' : 'Inspect scope'}
                </button>
              </section>
            ) : null}

            {/* Open Worker/Bot Question Context */}
            {context?.question ? (
              <section className="bot-task-card">
                <div className="bot-task-card-head">
                  <h2>{isZh ? `${profile.displayName} 正在等你答复` : `${profile.displayName} is waiting for your reply`}</h2>
                </div>
                <p className="bot-task-summary">{context.question.content}</p>
                <p className="bot-task-card-note">
                  {isZh ? '你可以直接在下方输入框答复，或点击顶部回到主对话操作快捷选项。' : 'Reply in the composer below or return to the main thread for quick options.'}
                </p>
              </section>
            ) : null}

            {/* Report & Verification Card */}
            <section className="bot-task-card">
              <div className="bot-task-card-head">
                <h2>{isZh ? '执行汇报与核验状态' : 'Execution report & verification'}</h2>
                <div className="bot-task-card-actions">
                  {evidenceCount > 0 ? (
                    <button type="button" className="bot-task-btn" onClick={() => openInspectorTab('evidence')}>
                      <PeerIcon name="panelRight" size={13} />
                      <span>{isZh ? `在右侧查看证据 (${evidenceCount})` : `Inspect evidence (${evidenceCount})`}</span>
                    </button>
                  ) : null}
                  {session.conversationId ? (
                    <button type="button" className="bot-task-btn" onClick={() => setSceneOpen((v) => !v)}>
                      <PeerIcon name="terminal" size={13} />
                      <span>{sceneOpen ? (isZh ? '收起完整执行过程' : 'Hide worker trace') : (isZh ? '查看完整执行过程' : 'View worker trace')}</span>
                    </button>
                  ) : null}
                </div>
              </div>
              {session.status === 'failed' && session.failure ? (
                <div className="bot-task-failure-banner" role="status">
                  <div className="bot-task-failure-head">
                    <PeerIcon name="warning" size={14} />
                    <strong>{formatFailureReason(session.failure, isZh)}</strong>
                    <code>{session.failure.code}</code>
                  </div>
                  <p className="bot-task-failure-note">
                    {isZh
                      ? '该任务在执行阶段中止，未进入结果核验。可查看执行过程定位细节，或点击下方「基于此重跑」。'
                      : 'This task stopped during execution before verification. Inspect the worker trace or use Re-run draft below.'}
                  </p>
                </div>
              ) : null}
              {session.workerOutput ? (
                <p className="bot-task-summary">{session.workerOutput}</p>
              ) : session.status !== 'failed' && !session.verification ? (
                <p className="bot-task-card-note">
                  {reportRead.state === 'loading'
                    ? i18n.t('projectAgent.drawer.task.readingReport')
                    : (isZh ? '任务正在推进或尚未产出执行汇报，可展开执行过程查看实时进展。' : 'No execution report yet. Open the worker trace for live steps.')}
                </p>
              ) : null}
              {session.verification ? (() => {
                const attempts = session.verification.reviewAttempts;
                const latestAttempt = attempts.at(-1);
                const attemptCount = attempts.length;
                const verdictDetail = session.verification.summary
                  || (latestAttempt?.failureReason ? formatFailureReason({ code: latestAttempt.failureReason }, isZh) : '')
                  || (session.verification.error ? formatFailureReason({ code: session.verification.error }, isZh) : '');
                return (
                  <div className="bot-task-verdict-banner">
                    <div className="bot-task-verdict-copy">
                      <strong>
                        {session.verification.outcome === 'passed'
                          ? (isZh ? '独立只读核验通过' : 'Independent verification passed')
                          : session.verification.outcome === 'failed'
                            ? (isZh
                              ? `独立核验未通过${attemptCount > 0 ? `（已完成 ${Math.min(attemptCount, 3)}/3 次）` : ''}`
                              : `Verification failed${attemptCount > 0 ? ` (${Math.min(attemptCount, 3)}/3)` : ''}`)
                            : (isZh ? '独立核验进行中或部分完成' : 'Verification in progress')}
                      </strong>
                      {verdictDetail ? (
                        <p className="bot-task-verdict-summary">{verdictDetail}</p>
                      ) : null}
                      <span>
                        {isZh
                          ? `共 ${session.verification.checks.length} 项检查 · ${session.verification.outputs.length} 份已登记产物`
                          : `${session.verification.checks.length} checks · ${session.verification.outputs.length} indexed outputs`}
                      </span>
                    </div>
                    <button type="button" className="bot-task-btn" onClick={() => openInspectorTab('verdict')}>
                      {isZh ? '查看核验裁决' : 'View verdict'}
                    </button>
                  </div>
                );
              })() : null}
            </section>

            {/* Task Brief / Delegated Instructions (kept distinct from execution report) */}
            {session.summary && session.summary !== session.workerOutput ? (
              <section className="bot-task-card bot-task-brief-card">
                <div className="bot-task-card-head">
                  <h2>{isZh ? '任务说明' : 'Task brief'}</h2>
                </div>
                <p className="bot-task-brief-text">{session.summary}</p>
              </section>
            ) : null}

            {/* Optional Expandable Worker Execution Trace */}
            {sceneOpen && session.conversationId ? (
              <div className="bot-task-scene-wrap">
                <ConversationSceneDrawer
                  embedded
                  task={session.planId ? { sessionId: session.sessionId, planId: session.planId } : undefined}
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                  conversationId={session.conversationId}
                  title={title}
                  i18n={i18n}
                  isZh={isZh}
                  onClose={() => setSceneOpen(false)}
                  onOpenBot={() => onBackToBot(originMessageId)}
                />
              </div>
            ) : null}
          </div>
        </div>

        {/* Bottom Docked Task Touch Bar + Follow-up Composer */}
        <div className="bot-composer-shell">
          <div className="bot-composer-unit">
            <ComposerTouchBar
              kind="task"
              session={session}
              evidenceCount={evidenceCount}
              inspectorOpen={inspectorOpen}
              hasPendingApproval={Boolean(pendingApproval)}
              approvalBusy={approvalBusy}
              verifyBusy={verifyBusy}
              cancelBusy={Boolean(cancelState?.pending || session.status === 'stopping')}
              i18n={i18n}
              onToggleInspector={onToggleInspector}
              onApprove={pendingApproval ? () => void handleApprovalDecision('approve') : undefined}
              onReject={pendingApproval ? () => void handleApprovalDecision('reject') : undefined}
              onVerify={() => void handleReverify()}
              onCancel={cancellation ? () => { void cancellation.cancel(sessionId); } : undefined}
              onCiteToBot={() => onCiteToBot(taskRefPayload)}
              onRerunDraft={() => onCiteToBot(
                taskRefPayload,
                isZh ? `请基于「${title}」的范围与验收标准重新执行。` : `Please re-run based on "${title}".`,
              )}
            />
            <form
              className="bot-task-followup-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSendFollowUp();
              }}
            >
              <textarea
                rows={1}
                value={followUpText}
                disabled={sendingFollowUp}
                placeholder={isZh ? `围绕「${title}」追问或补充说明…` : `Ask a follow-up about "${title}"…`}
                aria-label={isZh ? '围绕当前任务追问' : 'Task follow-up'}
                onChange={(e) => setFollowUpText(e.target.value)}
                onCompositionStart={(e) => composition.start(e.currentTarget)}
                onCompositionEnd={(e) => composition.end(e.currentTarget)}
                onKeyUp={(e) => composition.keyUp(e.nativeEvent)}
                onBlur={() => composition.reset()}
                onKeyDown={(e) => {
                  if (composition.keyDown(e.nativeEvent)) return;
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendFollowUp();
                  }
                }}
              />
              <div className="bot-task-followup-foot bot-composer-bar">
                <div className="bot-task-followup-leading">
                  <BotAccessControl workspaceId={workspaceId} i18n={i18n} onSavingChange={setPermissionSaving} />
                  <span className="bot-task-followup-hint">
                    {isZh ? `围绕当前任务发送给 ${profile.displayName}` : `Sends to ${profile.displayName} with task context`}
                  </span>
                </div>
                <button
                  type="submit"
                  className="bot-task-send-btn"
                  disabled={sendingFollowUp || permissionSaving || !followUpText.trim()}
                  aria-label={i18n.t('projectAgent.chat.send')}
                  title={i18n.t('projectAgent.chat.send')}
                >
                  <PeerIcon name="send" size={16} />
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <TaskEvidenceInspector
        open={inspectorOpen}
        overlay={overlayInspector}
        workspaceId={workspaceId}
        session={session}
        initialTab={inspectorTab}
        i18n={i18n}
        triggerRef={inspectorTriggerRef}
        onClose={onCloseInspector}
        onSelectSession={onOpenTask}
      />
    </div>
  );
}
