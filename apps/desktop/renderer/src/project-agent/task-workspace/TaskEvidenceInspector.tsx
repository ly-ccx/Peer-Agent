import { memo, useEffect, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import { useInteractionLayer } from '../../app/hooks/useInteractionLayer';
import type { DrawerSession } from '../state/drawerState';
import { TaskVerification } from '../drawer/TaskVerification';
import { CoordinationDetails } from '../drawer/CoordinationDetails';

export type InspectorTab = 'brief' | 'verdict' | 'coordination';

export interface TaskEvidenceInspectorProps {
  readonly open: boolean;
  readonly overlay: boolean;
  readonly workspaceId: string;
  readonly session: DrawerSession;
  readonly initialTab?: InspectorTab;
  readonly i18n: I18nRuntime;
  readonly triggerRef: React.RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onSelectSession?: (sessionId: string) => void;
}

export const TaskEvidenceInspector = memo(function TaskEvidenceInspector({
  open,
  overlay,
  workspaceId,
  session,
  initialTab = 'brief',
  i18n,
  triggerRef,
  onClose,
  onSelectSession,
}: TaskEvidenceInspectorProps) {
  const isZh = i18n.locale.startsWith('zh');
  const hasVerification = Boolean(
    session.verification && (
      session.verification.reviewAttempts.length > 0
      || session.verification.checks.some(
        (check) => check.name === 'independent_verifier' && check.reason !== 'not_required',
      )
    ),
  );
  const resolvedInitialTab: InspectorTab = initialTab === 'verdict' && !hasVerification ? 'brief' : initialTab;
  const [tab, setTab] = useState<InspectorTab>(resolvedInitialTab);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open) setTab(resolvedInitialTab);
  }, [resolvedInitialTab, open]);

  useInteractionLayer(open && overlay, {
    roots: [panelRef],
    trigger: triggerRef,
    modal: false,
    outside: true,
    onClose,
  });

  if (!open) return null;

  const tabs: ReadonlyArray<readonly [InspectorTab, string]> = hasVerification
    ? [
        ['brief', isZh ? '说明' : 'Brief'],
        ['verdict', isZh ? '核验' : 'Verdict'],
        ['coordination', isZh ? '边界与信息' : 'Scope'],
      ]
    : [
        ['brief', isZh ? '说明' : 'Brief'],
        ['coordination', isZh ? '边界与信息' : 'Scope'],
      ];

  const activeTab: InspectorTab = tab === 'verdict' && !hasVerification ? 'brief' : tab;

  return (
    <aside
      ref={panelRef}
      className={`bot-task-inspector${overlay ? ' is-overlay' : ''}`}
      aria-label={isZh ? '任务详情' : 'Task details'}
    >
      <header className="bot-inspector-head">
        <span className="bot-inspector-title">
          {isZh ? '任务详情' : 'Task Details'}
        </span>
        <button
          type="button"
          className="bot-tray-close"
          aria-label={isZh ? '关闭详情抽屉' : 'Close task details'}
          onClick={onClose}
        >
          <PeerIcon name="close" size={14} />
        </button>
      </header>
      <div className="bot-inspector-tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={activeTab === key}
            className={`bot-inspector-tab${activeTab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="bot-inspector-body">
        {activeTab === 'brief' ? (
          <div className="bot-inspector-brief">
            {session.failure ? (
              <section className="bot-inspector-section">
                <h3>{isZh ? '中止原因' : 'Failure detail'}</h3>
                <p className="bot-inspector-brief-text">
                  {session.failure.message && session.failure.message !== session.failure.code
                    ? session.failure.message
                    : session.failure.code}
                </p>
                <code className="bot-inspector-code">{session.failure.code}</code>
              </section>
            ) : null}
            {session.summary ? (
              <section className="bot-inspector-section">
                <h3>{isZh ? '委派说明' : 'Delegated brief'}</h3>
                <p className="bot-inspector-brief-text">{session.summary}</p>
              </section>
            ) : (
              <p className="bot-inspector-empty">
                {isZh ? '暂无额外任务说明。' : 'No task brief recorded.'}
              </p>
            )}
            {session.workerOutput && session.workerOutput !== session.summary ? (
              <section className="bot-inspector-section">
                <h3>{isZh ? '执行汇报摘要' : 'Execution summary'}</h3>
                <p className="bot-inspector-brief-text">{session.workerOutput}</p>
              </section>
            ) : null}
          </div>
        ) : activeTab === 'verdict' ? (
          session.verification ? (
            <TaskVerification detail={session.verification} i18n={i18n} />
          ) : (
            <p className="bot-inspector-empty">
              {isZh ? '当前尚未生成独立核验裁决。' : 'No independent verification verdict yet.'}
            </p>
          )
        ) : (
          <div className="bot-inspector-scope">
            <CoordinationDetails
              session={session}
              i18n={i18n}
              workspaceId={workspaceId}
              onSelect={onSelectSession}
            />
            <dl className="bot-inspector-meta">
              <div>
                <dt>{i18n.t('projectAgent.drawer.task.id')}</dt>
                <dd><code>{session.sessionId}</code></dd>
              </div>
              {session.modelLabel ? (
                <div>
                  <dt>{i18n.t('projectAgent.drawer.frozenModel')}</dt>
                  <dd>{session.modelLabel}</dd>
                </div>
              ) : null}
              {session.anchorMessageId ? (
                <div>
                  <dt>{i18n.t('projectAgent.drawer.anchor')}</dt>
                  <dd><code>{session.anchorMessageId}</code></dd>
                </div>
              ) : null}
            </dl>
          </div>
        )}
      </div>
    </aside>
  );
});
