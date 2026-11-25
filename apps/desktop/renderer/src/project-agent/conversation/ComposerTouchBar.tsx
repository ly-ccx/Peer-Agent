import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import { ExecutorIcon, executorDisplayName } from '../ExecutorIcon';
import type { DrawerSession } from '../state/drawerState';
import { formatDrawerSessionStatus } from '../state/drawerState';
import { canCancelTask } from '../state/botWorkState';
import { summarizeActiveSessions, type SidebarTaskEntry } from '../state/botNavigationState';
import { workerStatus } from '../state/workerStatus';
import type { TouchBarTrayMode } from './TouchBarTray';

export interface BotChatTouchBarProps {
  readonly kind: 'bot';
  readonly activeTasks: readonly SidebarTaskEntry[];
  readonly historyTotal: number;
  readonly trayMode: TouchBarTrayMode;
  readonly i18n: I18nRuntime;
  readonly activeTriggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly historyTriggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly onToggleTray: (mode: Exclude<TouchBarTrayMode, null>) => void;
}

export interface TaskWorkspaceTouchBarProps {
  readonly kind: 'task';
  readonly session: DrawerSession;
  readonly evidenceCount: number;
  readonly inspectorOpen: boolean;
  readonly hasPendingApproval: boolean;
  readonly approvalBusy?: boolean;
  readonly verifyBusy?: boolean;
  readonly cancelBusy?: boolean;
  readonly i18n: I18nRuntime;
  readonly onToggleInspector: () => void;
  readonly onApprove?: () => void;
  readonly onReject?: () => void;
  readonly onVerify?: () => void;
  readonly onCancel?: () => void;
  readonly onCiteToBot?: () => void;
  readonly onRerunDraft?: () => void;
}

export type ComposerTouchBarProps = BotChatTouchBarProps | TaskWorkspaceTouchBarProps;

export function ComposerTouchBar(props: ComposerTouchBarProps) {
  const isZh = props.i18n.locale.startsWith('zh');

  if (props.kind === 'bot') {
    const summary = summarizeActiveSessions(props.activeTasks, isZh);
    const isIdle = summary.total === 0;
    const running = props.activeTasks.filter(task => workerStatus(task.status, task.followUp, props.i18n).tone === 'active').length;
    const summaryText = isIdle
      ? (isZh ? '无进行中任务' : 'No active tasks')
      : isZh ? `${summary.total} 个任务 · ${running} 个运行中`
        : `${summary.total} ${summary.total === 1 ? 'worker' : 'workers'} · ${running} running`;

    return (
      <div className="bot-touchbar-strip bot-touchbar-summary" role="toolbar" aria-label={isZh ? 'Bot 快捷栏' : 'Bot Touch Bar'}>
        <div className="bot-tb-left">
          <button
            ref={props.activeTriggerRef}
            type="button"
            className={`bot-tb-status${isIdle ? ' is-idle' : ''}${props.trayMode === 'active' ? ' is-open' : ''}`}
            title={!isIdle ? summary.segments.join(' · ') : undefined}
            disabled={isIdle}
            aria-expanded={props.trayMode === 'active'}
            onClick={() => !isIdle && props.onToggleTray('active')}
          >
            {!isIdle ? (
              <span className="bot-tb-glyph" data-tone={summary.leadTone}>
                <ExecutorIcon size={13} title={executorDisplayName('peer', isZh)} />
              </span>
            ) : null}
            <span className="bot-tb-status-text">{summaryText}</span>
            {!isIdle ? (
              <PeerIcon name={props.trayMode === 'active' ? 'chevronDown' : 'chevronUp'} size={12} />
            ) : null}
          </button>
        </div>
        <div className="bot-tb-right">
          <button
            ref={props.historyTriggerRef}
            type="button"
            className={`bot-tb-chip${props.trayMode === 'history' ? ' is-open' : ''}`}
            aria-expanded={props.trayMode === 'history'}
            onClick={() => props.onToggleTray('history')}
          >
            <PeerIcon name="history" size={13} />
            <span>{isZh ? '历史任务' : 'History'}</span>
            {props.historyTotal > 0 ? <span className="bot-tb-count">{props.historyTotal}</span> : null}
            <PeerIcon name={props.trayMode === 'history' ? 'chevronDown' : 'chevronUp'} size={12} />
          </button>
        </div>
      </div>
    );
  }

  const { session, evidenceCount, inspectorOpen, hasPendingApproval, i18n } = props;
  const followUp = session.followUp;
  const ended = followUp ? !followUp.inCurrentList : ['accepted', 'cancelled', 'superseded', 'paused', 'failed'].includes(session.status);
  const verifyFailed = session.status === 'result_ready' && followUp?.reason === 'verification_failed';
  const cancelable = !ended && canCancelTask(session.status, session.cancelable);
  const statusText = formatDrawerSessionStatus(session, i18n);
  const verifyAttempts = session.verification?.reviewAttempts.length ?? 0;
  const canReverify = verifyFailed && verifyAttempts < 3;
  const reverifyExhausted = verifyFailed && verifyAttempts >= 3;

  const tone = hasPendingApproval || followUp?.owner === 'user'
    ? 'warn'
    : verifyFailed || session.status === 'failed'
      ? 'danger'
      : ended
        ? (session.status === 'accepted' ? 'good' : 'muted')
        : 'azure';
  const spinning = !ended && !hasPendingApproval && !verifyFailed && ['starting', 'running', 'verifying', 'result_ready'].includes(session.status);

  return (
    <div className="bot-touchbar-strip" role="toolbar" aria-label={isZh ? '任务快捷栏' : 'Task Touch Bar'}>
      <div className="bot-tb-left">
        <div className="bot-tb-status is-static">
          <span className="bot-tb-glyph" data-tone={tone} aria-hidden="true">
            <PeerIcon
              name={tone === 'good' ? 'check' : tone === 'warn' || tone === 'danger' ? 'warning' : spinning ? 'loader' : 'circle'}
              size={13}
              className={spinning ? 'motion-spin' : undefined}
            />
          </span>
          <span className="bot-tb-status-text">{statusText}</span>
        </div>
      </div>
      <div className="bot-tb-right">
        {hasPendingApproval ? (
          <>
            <button type="button" className={`bot-tb-chip${inspectorOpen ? ' is-toggle-active' : ''}`} onClick={props.onToggleInspector}>
              <PeerIcon name="panelRight" size={13} />
              <span>{isZh ? '核查范围' : 'Scope'}</span>
            </button>
            {props.onReject ? (
              <button type="button" className="bot-tb-chip" disabled={props.approvalBusy} onClick={props.onReject}>
                {isZh ? '拒绝' : 'Reject'}
              </button>
            ) : null}
            {props.onApprove ? (
              <button type="button" className="bot-tb-chip is-cta" disabled={props.approvalBusy} onClick={props.onApprove}>
                <PeerIcon name="check" size={13} />
                <span>{props.approvalBusy ? (isZh ? '提交中…' : 'Submitting…') : (isZh ? '批准计划' : 'Approve')}</span>
              </button>
            ) : null}
          </>
        ) : canReverify && props.onVerify ? (
          <>
            <button type="button" className={`bot-tb-chip${inspectorOpen ? ' is-toggle-active' : ''}`} onClick={props.onToggleInspector}>
              <PeerIcon name="panelRight" size={13} />
              <span>{isZh ? `证据${evidenceCount ? ` ${evidenceCount}` : ''}` : `Evidence${evidenceCount ? ` ${evidenceCount}` : ''}`}</span>
            </button>
            {cancelable && props.onCancel ? (
              <button type="button" className="bot-tb-chip" disabled={props.cancelBusy} onClick={props.onCancel}>
                <PeerIcon name="close" size={12} />
                <span>{props.cancelBusy ? (isZh ? '正在关闭…' : 'Closing…') : (isZh ? '关闭任务' : 'Dismiss')}</span>
              </button>
            ) : null}
            <button type="button" className="bot-tb-chip is-cta" disabled={props.verifyBusy} onClick={props.onVerify}>
              <PeerIcon name="repeat" size={13} className={props.verifyBusy ? 'motion-spin' : undefined} />
              <span>
                {props.verifyBusy
                  ? (isZh ? '核验中…' : 'Verifying…')
                  : (isZh ? `重新核验 (${Math.min(verifyAttempts + 1, 3)}/3)` : `Re-verify (${Math.min(verifyAttempts + 1, 3)}/3)`)}
              </span>
            </button>
          </>
        ) : reverifyExhausted ? (
          <>
            <button type="button" className={`bot-tb-chip${inspectorOpen ? ' is-toggle-active' : ''}`} onClick={props.onToggleInspector}>
              <PeerIcon name="panelRight" size={13} />
              <span>{isZh ? `证据${evidenceCount ? ` ${evidenceCount}` : ''}` : `Evidence${evidenceCount ? ` ${evidenceCount}` : ''}`}</span>
            </button>
            {cancelable && props.onCancel ? (
              <button type="button" className="bot-tb-chip" disabled={props.cancelBusy} onClick={props.onCancel}>
                <PeerIcon name="close" size={12} />
                <span>{props.cancelBusy ? (isZh ? '正在关闭…' : 'Closing…') : (isZh ? '关闭任务' : 'Dismiss')}</span>
              </button>
            ) : null}
            {props.onRerunDraft ? (
              <button type="button" className="bot-tb-chip is-cta" onClick={props.onRerunDraft}>
                <PeerIcon name="repeat" size={13} />
                <span>{isZh ? '基于此重跑' : 'Re-run draft'}</span>
              </button>
            ) : null}
          </>
        ) : ended ? (
          <>
            {evidenceCount > 0 ? (
              <button type="button" className={`bot-tb-chip${inspectorOpen ? ' is-toggle-active' : ''}`} onClick={props.onToggleInspector}>
                <PeerIcon name="panelRight" size={13} />
                <span>{isZh ? `证据 ${evidenceCount}` : `Evidence ${evidenceCount}`}</span>
              </button>
            ) : null}
            {props.onCiteToBot ? (
              <button type="button" className="bot-tb-chip" onClick={props.onCiteToBot}>
                <span>@ {isZh ? '引用回对话' : 'Cite in chat'}</span>
              </button>
            ) : null}
            {props.onRerunDraft ? (
              <button type="button" className="bot-tb-chip is-cta" onClick={props.onRerunDraft}>
                <PeerIcon name="repeat" size={13} />
                <span>{isZh ? '基于此重跑' : 'Re-run draft'}</span>
              </button>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" className={`bot-tb-chip${inspectorOpen ? ' is-toggle-active' : ''}`} onClick={props.onToggleInspector}>
              <PeerIcon name="panelRight" size={13} />
              <span>{isZh ? `证据${evidenceCount ? ` ${evidenceCount}` : ''}` : `Evidence${evidenceCount ? ` ${evidenceCount}` : ''}`}</span>
            </button>
            {cancelable && props.onCancel ? (
              <button type="button" className="bot-tb-chip" disabled={props.cancelBusy} onClick={props.onCancel}>
                <PeerIcon name="stop" size={12} />
                <span>{props.cancelBusy ? (isZh ? '正在停止…' : 'Stopping…') : (isZh ? '停止' : 'Stop')}</span>
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
