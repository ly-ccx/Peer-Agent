import type { I18nRuntime } from '@peer-agent/i18n';
import { useResourceWorkspace } from '../../workbench/ResourceWorkspaceContext';
import { PeerIcon } from '../../ui/icons';
import type { DrawerSession } from '../state/drawerState';

/** One visible entry for list and detail; preserve the real child conversation and task provenance. */
export function TaskConversationButton({ workspaceId, workspacePath, session, title, i18n, className,
  onOpenFallback, onOpenBot,
}: {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly session: DrawerSession;
  readonly title: string;
  readonly i18n: I18nRuntime;
  readonly className: string;
  readonly onOpenFallback: (session: DrawerSession) => void;
  readonly onOpenBot: () => void;
}) {
  const resources = useResourceWorkspace();
  const unavailable = !session.conversationId || Boolean(resources && !resources.ready);
  const label = i18n.t('projectAgent.drawer.task.openConversation');
  return <button type="button" className={className} disabled={unavailable}
    aria-label={`${label}: ${title}`} title={unavailable ? i18n.t('projectAgent.drawer.task.conversationUnavailable') : undefined}
    onClick={() => {
      if (!session.conversationId || resources && !resources.ready) return;
      if (resources) resources.openConversation({ workspaceId, workspacePath, conversationId: session.conversationId, title,
        task: session.planId ? { sessionId: session.sessionId, planId: session.planId } : undefined, onOpenBot });
      else onOpenFallback(session);
    }}>
    {label}<PeerIcon name="arrowUpRight" size={14} />
  </button>;
}
