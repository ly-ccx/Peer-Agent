import { useEffect, useRef, useState } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';
import { useInteractionLayer } from '../../app/hooks/useInteractionLayer';
import type { DrawerSession } from '../state/drawerState';
import { EvidencePreview } from '../drawer/EvidencePreview';
import { TaskVerification } from '../drawer/TaskVerification';
import { CoordinationDetails } from '../drawer/CoordinationDetails';

export type InspectorTab = 'brief' | 'evidence' | 'verdict' | 'coordination';

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

export function TaskEvidenceInspector({
  open,
  overlay,
  workspaceId,
  session,
  initialTab = 'evidence',
  i18n,
  triggerRef,
  onClose,
  onSelectSession,
}: TaskEvidenceInspectorProps) {
  const isZh = i18n.locale.startsWith('zh');
  const [tab, setTab] = useState<InspectorTab>(initialTab);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [initialTab, open]);

  useInteractionLayer(open && overlay, {
    roots: [panelRef],
    trigger: triggerRef,
    modal: false,
    outside: true,
    onClose,
  });

  if (!open) return null;

  const allEvidenceRefs = [
    ...new Set([
      ...session.evidenceRefs,
      ...(session.verification?.checks.flatMap((c) => c.evidenceRefs) ?? []),
      ...(session.verification?.outputs.map((o) => o.evidenceRef) ?? []),
    ]),
  ];

  return (
    <aside
      ref={panelRef}
      className={`bot-task-inspector${overlay ? ' is-overlay' : ''}`}
      aria-label={isZh ? '任务详情与证据' : 'Task details & evidence'}
    >
      <header className="bot-inspector-head">
        <span className="bot-inspector-title">
          {isZh ? '任务详情与证据' : 'Task Details & Evidence'}
        </span>
        <button
          type="button"
          className="bot-tray-close"
          aria-label={isZh ? '关闭详情抽屉' : 'Close task inspector'}
          onClick={onClose}
        >
          <PeerIcon name="close" size={14} />
        </button>
      </header>
      <div className="bot-inspector-tabs" role="tablist">
        {([
          ['brief', isZh ? '说明' : 'Brief'],
          ['evidence', isZh ? `证据 (${allEvidenceRefs.length})` : `Evidence (${allEvidenceRefs.length})`],
          ['verdict', isZh ? '核验' : 'Verdict'],
          ['coordination', isZh ? '边界' : 'Scope'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`bot-inspector-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="bot-inspector-body">
        {tab === 'brief' ? (
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
        ) : tab === 'evidence' ? (
          allEvidenceRefs.length > 0 ? (
            <EvidencePreview
              refs={allEvidenceRefs}
              i18n={i18n}
              inline
              workspaceId={workspaceId}
              task={session.planId ? { sessionId: session.sessionId, planId: session.planId } : undefined}
            />
          ) : (
            <p className="bot-inspector-empty">
              {isZh ? '该任务尚未登记可查证的证据索引。' : 'No indexed evidence recorded for this task yet.'}
            </p>
          )
        ) : tab === 'verdict' ? (
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
}
