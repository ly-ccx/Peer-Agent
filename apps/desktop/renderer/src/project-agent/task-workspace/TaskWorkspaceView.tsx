import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile, InputDraftTaskRef } from '@peer-agent/protocol';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import { useCompositionGuard } from '../../app/hooks/useCompositionGuard';
import { BotAccessControl } from '../BotAccessControl';
import { formatDrawerSessionStatus, formatDrawerStamp, type DrawerSession } from '../state/drawerState';
import { mergeTaskDetail } from '../state/taskDetailState';
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
    model_http_rejected: '模型服务拒绝了本次请求',
    BACKGROUND_VERSION_CHANGED: '执行期间会话状态发生变更（如应用重启或并发写入）',
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
    model_http_rejected: 'Model provider rejected the request',
    BACKGROUND_VERSION_CHANGED: 'Conversation state changed mid-run (e.g. app restart or concurrent write)',
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
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('brief');
  const [pendingApproval, setPendingApproval] = useState<PendingTaskApproval | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ readonly text: string; readonly error?: boolean } | null>(null);
  const [followUpText, setFollowUpText] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [liveTick, setLiveTick] = useState(0);
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

  const isLiveSession = Boolean(
    session?.conversationId
    && ['queued', 'starting', 'running', 'verifying', 'waiting_agent'].includes(session.status),
  );

  useEffect(() => {
    setLiveTick(0);
    if (!isLiveSession) return;
    const timer = window.setInterval(() => {
      setLiveTick((tick) => tick + 1);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [isLiveSession, session?.conversationId]);

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

  useEffect(() => {
    setFeedback(null);
    setVerifyBusy(false);
    setApprovalBusy(false);
  }, [sessionId]);

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
          text: isZh ? `已发送给 ${profile.displayName}` : `Sent to ${profile.displayName}`,
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
          <div className="bot-task-empty-stage">
            <p className="bot-inspector-empty">
              {reportRead.state === 'loading'
                ? (isZh ? '正在读取子任务会话…' : 'Loading task session…')
                : (isZh ? '暂时无法读取该子任务。' : 'Task details are unavailable.')}
            </p>
            {reportRead.state === 'unavailable' ? (
              <button type="button" className="bot-task-btn" onClick={reportRead.refresh}>
                {i18n.t('projectAgent.background.retry')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const title = session.title && session.title !== session.sessionId
    ? session.title
    : i18n.t('projectAgent.chat.work.related');
  const statusLabel = formatDrawerSessionStatus(session, i18n);
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
  const cancelState = cancellation?.states[`${workspaceId}:${sessionId}`];

  const taskRefPayload: InputDraftTaskRef = {
    sessionId: session.sessionId,
    title,
    status: session.status,
    anchorMessageId: originMessageId,
  };

  const verificationNotice = session.verification?.outcome === 'failed'
    ? (session.verification.summary || (isZh ? '独立核验未通过，可展开核验查看详情或基于此重跑。' : 'Independent verification failed.'))
    : '';

  return (
    <div className="bot-task-workspace" ref={rootRef}>
      <div className="bot-task-stage">
        {/* Compact Single-Line Status Strip (keeps full height for the worker conversation) */}
        <header className="bot-task-strip">
          <div className="bot-task-strip-leading">
            <span className="bot-task-status-pill" data-tone={tone}>
              <PeerIcon
                name={tone === 'good' ? 'check' : tone === 'warn' || tone === 'danger' ? 'warning' : tone === 'azure' ? 'loader' : 'circle'}
                size={12}
                className={tone === 'azure' && !ended ? 'motion-spin' : undefined}
              />
              <span>{statusLabel}</span>
            </span>
            <h1 className="bot-task-strip-title" title={title}>{title}</h1>
            {session.modelLabel ? (
              <span className="bot-task-meta-text">{session.modelLabel}</span>
            ) : null}
            {stamp ? (
              <span className="bot-task-meta-text">{stamp}</span>
            ) : null}
          </div>
          <div className="bot-task-strip-actions">
            {session.verification ? (
              <button
                type="button"
                className="bot-task-strip-btn"
                data-tone={session.verification.outcome === 'passed' ? 'good' : session.verification.outcome === 'failed' ? 'danger' : undefined}
                onClick={() => openInspectorTab('verdict')}
              >
                {session.verification.outcome === 'passed'
                  ? (isZh ? '核验通过' : 'Verified')
                  : session.verification.outcome === 'failed'
                    ? (isZh ? '核验未通过' : 'Verdict failed')
                    : (isZh ? '核验中' : 'Verifying')}
              </button>
            ) : null}
            {session.summary ? (
              <button type="button" className="bot-task-strip-btn" onClick={() => openInspectorTab('brief')}>
                {isZh ? '任务说明' : 'Brief'}
              </button>
            ) : null}
            {evidenceCount > 0 ? (
              <button type="button" className="bot-task-strip-btn" onClick={() => openInspectorTab('evidence')}>
                {isZh ? `证据 (${evidenceCount})` : `Evidence (${evidenceCount})`}
              </button>
            ) : null}
          </div>
        </header>

        {/* Contextual 1-line notices (only shown for actionable states: approval / question / failure / feedback) */}
        {pendingApproval ? (
          <div className="bot-task-notice" data-tone="warn" role="status">
            <PeerIcon name="warning" size={14} />
            <span className="bot-task-notice-text">
              {pendingApproval.summary || (isZh ? '需要你确认是否批准执行该计划（操作按钮在下方）。' : 'Plan approval required (actions below).')}
            </span>
            <button type="button" className="bot-task-strip-btn" onClick={() => openInspectorTab('coordination')}>
              {isZh ? '核查边界' : 'Inspect scope'}
            </button>
          </div>
        ) : null}

        {context?.question ? (
          <div className="bot-task-notice" data-tone="warn" role="status">
            <PeerIcon name="info" size={14} />
            <span className="bot-task-notice-text">
              {isZh ? `${profile.displayName} 正在等你答复：${context.question.content}` : `${profile.displayName} is asking: ${context.question.content}`}
            </span>
          </div>
        ) : null}

        {session.status === 'failed' && session.failure ? (
          <div className="bot-task-notice" data-tone="danger" role="status">
            <PeerIcon name="warning" size={14} />
            <span className="bot-task-notice-text">
              {formatFailureReason(session.failure, isZh)}
            </span>
            <button type="button" className="bot-task-strip-btn" onClick={() => openInspectorTab('brief')}>
              {isZh ? '详情' : 'Details'}
            </button>
          </div>
        ) : verificationNotice ? (
          <div className="bot-task-notice" data-tone="danger" role="status">
            <PeerIcon name="warning" size={14} />
            <span className="bot-task-notice-text">{verificationNotice}</span>
            <button type="button" className="bot-task-strip-btn" onClick={() => openInspectorTab('verdict')}>
              {isZh ? '查看核验' : 'View verdict'}
            </button>
          </div>
        ) : null}

        {feedback ? (
          <div className="bot-task-notice" data-tone={feedback.error ? 'danger' : 'info'} role={feedback.error ? 'alert' : 'status'}>
            <span className="bot-task-notice-text">{feedback.text}</span>
          </div>
        ) : null}

        {/* Primary Stage: Direct Native Worker Conversation Stream (full height, zero card chrome) */}
        <div className="bot-task-conversation-stage">
          {session.conversationId ? (
            <ConversationSceneDrawer
              embedded
              seamless
              task={session.planId ? { sessionId: session.sessionId, planId: session.planId } : undefined}
              workspaceId={workspaceId}
              workspacePath={workspacePath}
              conversationId={session.conversationId}
              conversationRevision={`${session.status}:${session.sourceRevision ?? ''}:${session.observationRevision ?? ''}:${liveTick}`}
              isLive={isLiveSession}
              title={title}
              i18n={i18n}
              isZh={isZh}
              onClose={() => onBackToBot(originMessageId)}
              onOpenBot={() => onBackToBot(originMessageId)}
            />
          ) : (
            <div className="bot-task-empty-stage">
              <PeerIcon
                name={tone === 'azure' ? 'loader' : tone === 'danger' ? 'warning' : 'circle'}
                size={22}
                className={tone === 'azure' && !ended ? 'motion-spin' : undefined}
              />
              <p className="bot-task-empty-copy">
                {session.workerOutput
                  ? session.workerOutput
                  : session.status === 'queued'
                    ? (isZh ? '子任务已排队，等待启动执行会话…' : 'Task queued, waiting to start execution session…')
                    : session.status === 'failed'
                      ? (isZh ? '任务在创建执行会话前已中止，可点击下方「基于此重跑」。' : 'Stopped before the execution session started. Use Re-run below.')
                      : (isZh ? '正在启动执行会话…' : 'Starting execution session…')}
              </p>
              {session.summary ? (
                <button type="button" className="bot-task-btn" onClick={() => openInspectorTab('brief')}>
                  {isZh ? '查看任务说明' : 'View task brief'}
                </button>
              ) : null}
            </div>
          )}
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
