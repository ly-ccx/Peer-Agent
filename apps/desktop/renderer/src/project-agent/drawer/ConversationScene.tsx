import type { I18nRuntime } from '@peer-agent/i18n';
import type { LlmProviderConfigView } from '@peer-agent/protocol';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer } from '../../app/components/Drawer';
import { ChatSurface } from '../../app/components/deferredPanels';
import { clientApi } from '../../clientApi';
import { WorkbenchPanel } from '../../app/components/deferredPanels';
import { WorkbenchProvider } from '../../workbench/WorkbenchContext';
import { BotDocumentPreview } from '../conversation/BotDocumentPreview';
import { PeerIcon } from '../../ui/icons';

const noopSettings = () => {};

export const ConversationSceneDrawer = memo(function ConversationSceneDrawer({
  workspaceId,
  workspacePath,
  conversationId,
  conversationRevision,
  isLive = false,
  title,
  i18n,
  isZh,
  onClose,
  onOpenBot,
  embedded = false,
  seamless = false,
  active = true,
  task,
}: {
  readonly embedded?: boolean;
  readonly seamless?: boolean;
  readonly active?: boolean;
  readonly isLive?: boolean;
  readonly task?: { readonly sessionId: string; readonly planId: string };
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly conversationId: string;
  readonly conversationRevision?: string | null;
  readonly title: string;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onClose: () => void;
  readonly onOpenBot?: () => void;
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

  const workspaces = useMemo(
    () => (workspacePath ? [{ path: workspacePath, name: title }] : []),
    [workspacePath, title],
  );
  const handleProvidersRefresh = useCallback(async () => {
    setProviders(await clientApi.llmListProviders());
  }, []);

  const content = (requestClose: () => void) => <WorkbenchProvider conversationId={conversationId}
    isPageActive={active} layoutHost="local">
    <div className="conversation-chat-drawer-shell" data-seam="user_intervened">
      <div className="conversation-chat-drawer__body">
        <ChatSurface showComposer={false} showHeader={!seamless} externalStreaming={isLive} onOpenPermissionBot={onOpenBot} i18n={i18n} providers={providers}
          conversationId={conversationId} conversationRevision={conversationRevision} conversationTitle={title} systemInstructions={systemInstructions}
          replyLanguage={replyLanguage} gitBranchPrefix={gitBranchPrefix} onOpenSettings={noopSettings}
          onProvidersRefresh={handleProvidersRefresh}
          workspacePath={workspacePath} workspaces={workspaces}
          isPageActive={active} onClose={requestClose} />
      </div>
      {!embedded ? <WorkbenchPanel isZh={isZh} workspacePath={workspacePath} /> : null}
    </div>
  </WorkbenchProvider>;
  if (embedded && seamless) {
    return (
      <section className="bot-inline-scene bot-inline-scene--seamless" aria-label={i18n.t('projectAgent.drawer.scene')}>
        <BotDocumentPreview workspaceId={workspaceId} i18n={i18n} task={task}>{content(onClose)}</BotDocumentPreview>
      </section>
    );
  }
  if (embedded) return <section className="bot-inline-scene" aria-label={i18n.t('projectAgent.drawer.scene')}>
    <header className="bot-inline-scene-heading"><button type="button" className="ui-button" onClick={onClose}>
      <PeerIcon name="close" size={14} />{i18n.t('projectAgent.drawer.close')}</button><span>{title}</span></header>
    <BotDocumentPreview workspaceId={workspaceId} i18n={i18n} task={task}>{content(onClose)}</BotDocumentPreview>
  </section>;
  return <Drawer onClose={onClose} ariaLabel={i18n.t('projectAgent.drawer.scene')}
    panelClassName="conversation-result-drawer conversation-chat-drawer conversation-chat-drawer--nested" softBackdrop>
    {({ requestClose }) => content(requestClose)}
  </Drawer>;
});
