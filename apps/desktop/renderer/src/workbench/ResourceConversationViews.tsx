import { createI18n } from '@peer-agent/i18n';
import { useMemo } from 'react';
import { ConversationSceneDrawer } from '../project-agent/drawer/ConversationScene';
import { useResourceWorkspace } from './ResourceWorkspaceContext';

export function ResourceConversationViews({ isZh, visible, active }: {
  readonly isZh: boolean; readonly visible: boolean; readonly active: boolean;
}) {
  const workspace = useResourceWorkspace();
  const i18n = useMemo(() => createI18n(isZh ? 'zh-CN' : 'en-US'), [isZh]);
  return workspace?.conversations.map(tab => {
    const selected = tab.conversationId === workspace.activeConversationId;
    return <div key={tab.conversationId} className="workbench-view resource-conversation-view"
      data-active={visible && selected} inert={!visible || !selected} aria-hidden={!visible || !selected}>
      <ConversationSceneDrawer embedded active={active && visible && selected}
        workspaceId={tab.workspaceId} workspacePath={tab.workspacePath} conversationId={tab.conversationId}
        title={tab.title} task={tab.task} i18n={i18n} isZh={isZh}
        onClose={workspace.close} onOpenBot={tab.onOpenBot ? () => { workspace.close(); tab.onOpenBot?.(); } : undefined} />
    </div>;
  });
}
