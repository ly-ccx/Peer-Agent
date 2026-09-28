import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { Drawer } from '../../app/components/Drawer';
import { ChatSurface } from '../../chat/components/ChatSurface';
import { clientApi } from '../../clientApi';
import { WorkbenchPanel } from '../../workbench/WorkbenchPanel';
import { WorkbenchProvider } from '../../workbench/WorkbenchContext';
import type { DrawerSession } from '../state/drawerState';

export function SessionDetail({
  workspaceId,
  workspacePath,
  session,
  i18n,
  isZh,
  onBack,
}: {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly session: DrawerSession;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onBack: () => void;
}) {
  const [sceneOpen, setSceneOpen] = useState(false);
  return (
    <div className="bot-drawer-detail">
      <button type="button" onClick={onBack}>{i18n.t('projectAgent.drawer.back')}</button>
      <h2>{session.title}</h2>
      <dl>
        <div>
          <dt>{i18n.t('projectAgent.drawer.progress')}</dt>
          <dd>{session.progress || session.statusLabel || session.status}</dd>
        </div>
        <div>
          <dt>{i18n.t('projectAgent.drawer.anchor')}</dt>
          <dd>{session.anchorMessageId || i18n.t('projectAgent.drawer.missing')}</dd>
        </div>
        <div>
          <dt>{i18n.t('projectAgent.drawer.frozenModel')}</dt>
          <dd>{session.modelLabel || i18n.t('projectAgent.drawer.missing')}</dd>
        </div>
        <div>
          <dt>{i18n.t('projectAgent.drawer.conclusion')}</dt>
          <dd>{session.summary || i18n.t('projectAgent.drawer.missing')}</dd>
        </div>
        <div>
          <dt>{i18n.t('projectAgent.drawer.evidence')}</dt>
          <dd>{session.evidenceRefs.length > 0 ? session.evidenceRefs.join('、') : i18n.t('projectAgent.drawer.missing')}</dd>
        </div>
      </dl>
      <button
        type="button"
        disabled={!session.conversationId}
        onClick={() => setSceneOpen(true)}
      >
        {session.conversationId ? i18n.t('projectAgent.drawer.openScene') : i18n.t('projectAgent.drawer.sceneMissing')}
      </button>
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
