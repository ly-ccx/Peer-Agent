import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { Drawer } from '../../app/components/Drawer';
import { ChatSurface } from '../../chat/components/ChatSurface';
import { clientApi } from '../../clientApi';
import { WorkbenchPanel } from '../../workbench/WorkbenchPanel';
import { WorkbenchProvider } from '../../workbench/WorkbenchContext';
import { PeerIcon } from '../../ui/icons/PeerIcon';
import type { DrawerSession } from '../state/drawerState';
import { sessionDetailPresentation } from './sessionDetailPresentation';

export function SessionDetail({
  workspaceId,
  workspacePath,
  session,
  reportState = 'ready',
  i18n,
  isZh,
  onBack,
}: {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly session: DrawerSession;
  readonly reportState?: 'loading' | 'ready' | 'unavailable';
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onBack: () => void;
}) {
  const [sceneOpen, setSceneOpen] = useState(false);
  const view = sessionDetailPresentation(session, i18n);
  return (
    <div className="bot-drawer-detail bot-session-detail" data-status={session.status}>
      <button className="bot-session-back" type="button" onClick={onBack}>
        <PeerIcon name="chevronLeft" />
        {i18n.t('projectAgent.drawer.taskDetail.back')}
      </button>
      <header className="bot-session-heading">
        <h2>{view.title}</h2>
      </header>
      <section className="bot-session-progress" aria-label={i18n.t('projectAgent.drawer.progress')}>
        <h3 className={`bot-session-status is-${view.tone}`}>{view.statusLabel}</h3>
        <p className="bot-session-hint">
          {view.progressDetail ? <span className="bot-session-progress-note">{view.progressDetail}<br /></span> : null}
          <span>{session.conversationId ? view.hint : i18n.t('projectAgent.drawer.taskDetail.noScene')}</span>
        </p>
        {session.conversationId ? (
          <button className="bot-session-open" type="button" onClick={() => setSceneOpen(true)}>
            {view.actionLabel}
            <PeerIcon name="arrowUpRight" size={14} />
          </button>
        ) : null}
      </section>
      <section className={`bot-session-report${view.report ? '' : ' is-empty'}`} aria-busy={reportState === 'loading'} aria-label={i18n.t('projectAgent.drawer.taskDetail.report')}>
        {view.report || view.evidenceRefs.length ? <div className="bot-session-report-heading">
          <h3>{i18n.t('projectAgent.drawer.taskDetail.report')}</h3>
          {view.evidenceRefs.length ? <span>{i18n.t('projectAgent.drawer.taskDetail.evidenceCount', { count: view.evidenceRefs.length })}</span> : null}
        </div> : null}
        {view.report ? <p className="bot-session-report-text">{view.report}</p> : (
          <p className="bot-session-empty" role={reportState === 'ready' ? undefined : 'status'}>{i18n.t(reportState === 'loading'
            ? 'projectAgent.drawer.taskDetail.readingReport' : reportState === 'unavailable'
              ? 'projectAgent.drawer.taskDetail.reportUnavailable' : 'projectAgent.drawer.taskDetail.noReport')}</p>
        )}
        {view.report && reportState === 'unavailable' ? <p className="bot-session-hint" role="status">{i18n.t('projectAgent.drawer.taskDetail.reportStale')}</p> : null}
      </section>
      <details className="bot-session-info">
        <summary><PeerIcon name="chevronRight" />{i18n.t('projectAgent.drawer.taskDetail.info')}</summary>
        <dl>
          {session.modelLabel ? <div>
            <dt>{i18n.t('projectAgent.drawer.taskDetail.model')}</dt><dd>{session.modelLabel}</dd>
          </div> : null}
          {view.createdLabel ? <div>
            <dt>{i18n.t('projectAgent.drawer.taskDetail.createdAt')}</dt>
            <dd><time dateTime={session.spawnedAt}>{new Date(session.spawnedAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}</time></dd>
          </div> : null}
          <div><dt>{i18n.t('projectAgent.drawer.taskDetail.id')}</dt><dd><code>{session.sessionId}</code></dd></div>
          {session.anchorMessageId ? <div>
            <dt>{i18n.t('projectAgent.drawer.taskDetail.sourceId')}</dt><dd><code>{session.anchorMessageId}</code></dd>
          </div> : null}
        </dl>
        {view.evidenceRefs.length ? <details className="bot-session-evidence">
          <summary><PeerIcon name="chevronRight" />{i18n.t('projectAgent.drawer.taskDetail.evidenceRefs')}</summary>
          <p>{i18n.t('projectAgent.drawer.taskDetail.evidenceHint')}</p>
          <ul>{view.evidenceRefs.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul>
        </details> : null}
      </details>
      {sceneOpen && session.conversationId ? (
        <ConversationSceneDrawer
          workspaceId={workspaceId}
          workspacePath={workspacePath}
          conversationId={session.conversationId}
          title={session.title}
          i18n={i18n}
          isZh={isZh}
          onClose={() => setSceneOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function ConversationSceneDrawer({
  workspacePath,
  conversationId,
  title,
  i18n,
  isZh,
  onClose,
}: {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly conversationId: string;
  readonly title: string;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onClose: () => void;
}) {
  const [providers, setProviders] = useState<readonly LlmProviderConfigView[]>([]);
  const [systemInstructions, setSystemInstructions] = useState('');
  const [replyLanguage, setReplyLanguage] = useState('');
  const [gitBranchPrefix, setGitBranchPrefix] = useState('');

  useEffect(() => {
    let cancelled = false;
    void clientApi.llmListProviders().then((listed) => {
      if (!cancelled) setProviders(listed ?? []);
    }).catch(() => {});
    void clientApi.getSettings().then((settings) => {
      if (cancelled || !settings) return;
      if (typeof settings.systemInstructions === 'string') setSystemInstructions(settings.systemInstructions);
      if (typeof settings.replyLanguage === 'string') setReplyLanguage(settings.replyLanguage);
      if (typeof settings.gitBranchPrefix === 'string') setGitBranchPrefix(settings.gitBranchPrefix);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  return (
    <Drawer
      onClose={onClose}
      ariaLabel={i18n.t('projectAgent.drawer.scene')}
      panelClassName="conversation-result-drawer conversation-chat-drawer conversation-chat-drawer--nested"
      softBackdrop
    >
      <WorkbenchProvider conversationId={conversationId} isPageActive layoutHost="local">
        <div className="conversation-chat-drawer-shell" data-seam="user_intervened">
          <div className="conversation-chat-drawer__body">
            <ChatSurface
              i18n={i18n}
              providers={providers}
              conversationId={conversationId}
              conversationTitle={title}
              systemInstructions={systemInstructions}
              replyLanguage={replyLanguage}
              gitBranchPrefix={gitBranchPrefix}
              onOpenSettings={() => {}}
              onProvidersRefresh={async () => {
                setProviders(await clientApi.llmListProviders());
              }}
              workspacePath={workspacePath}
              workspaces={workspacePath ? [{ path: workspacePath, name: title }] : []}
              isPageActive
              onClose={onClose}
            />
          </div>
          <WorkbenchPanel isZh={isZh} workspacePath={workspacePath} />
        </div>
      </WorkbenchProvider>
    </Drawer>
  );
}
