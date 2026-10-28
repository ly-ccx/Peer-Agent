import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { Drawer } from '../../app/components/Drawer';
import { ChatSurface } from '../../chat/components/ChatSurface';
import { clientApi } from '../../clientApi';
import { WorkbenchPanel } from '../../workbench/WorkbenchPanel';
import { WorkbenchProvider } from '../../workbench/WorkbenchContext';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import { BotDocumentPreview } from '../conversation/BotDocumentPreview';
import { PeerIcon } from '../../ui/icons';

export function ConversationSceneDrawer({
  workspaceId,
  workspacePath,
  conversationId,
  title,
  i18n,
  isZh,
  onClose,
  onOpenBot,
  embedded = false,
  task,
}: {
  readonly embedded?: boolean;
  readonly task?: { readonly sessionId: string; readonly planId: string };
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly conversationId: string;
  readonly title: string;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onClose: () => void;
  readonly onOpenBot?: () => void;
}) {
  const workspace = useResourceWorkspace();
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

  const content = (requestClose: () => void) => <WorkbenchProvider conversationId={conversationId}
    isPageActive={!embedded || !!workspace?.detailsVisible} layoutHost="local">
    <div className="conversation-chat-drawer-shell" data-seam="user_intervened">
      <div className="conversation-chat-drawer__body">
        <ChatSurface showComposer={false} onOpenPermissionBot={onOpenBot} i18n={i18n} providers={providers}
          conversationId={conversationId} conversationTitle={title} systemInstructions={systemInstructions}
          replyLanguage={replyLanguage} gitBranchPrefix={gitBranchPrefix} onOpenSettings={() => {}}
          onProvidersRefresh={async () => { setProviders(await clientApi.llmListProviders()); }}
          workspacePath={workspacePath} workspaces={workspacePath ? [{ path: workspacePath, name: title }] : []}
          isPageActive={!embedded || !!workspace?.detailsVisible} onClose={requestClose} />
      </div>
      {!embedded ? <WorkbenchPanel isZh={isZh} workspacePath={workspacePath} /> : null}
    </div>
  </WorkbenchProvider>;
  if (embedded) return <section className="bot-inline-scene" aria-label={i18n.t('projectAgent.drawer.scene')}>
    <header className="bot-inline-scene-heading"><button type="button" className="ui-button" onClick={onClose}>
      <PeerIcon name="back" size={14} />{i18n.t('projectAgent.drawer.sceneBack')}</button><span>{title}</span></header>
    <BotDocumentPreview workspaceId={workspaceId} i18n={i18n} task={task}>{content(onClose)}</BotDocumentPreview>
  </section>;
  return <Drawer onClose={onClose} ariaLabel={i18n.t('projectAgent.drawer.scene')}
    panelClassName="conversation-result-drawer conversation-chat-drawer conversation-chat-drawer--nested" softBackdrop>
    {({ requestClose }) => content(requestClose)}
  </Drawer>;
}
