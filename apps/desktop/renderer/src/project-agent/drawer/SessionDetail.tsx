import type { I18nRuntime } from '@peer-agent/i18n';
import { WORK_SESSION_STATUSES, type LlmProviderConfigView } from '@peer-agent/protocol';
import { useEffect, useState } from 'react';
import { Drawer } from '../../app/components/Drawer';
import { ChatSurface } from '../../chat/components/ChatSurface';
import { clientApi } from '../../clientApi';
import { WorkbenchPanel } from '../../workbench/WorkbenchPanel';
import { WorkbenchProvider } from '../../workbench/WorkbenchContext';
import { formatDrawerSessionStatus, formatDrawerStamp, type DrawerSession } from '../state/drawerState';
import { PeerIcon } from '../../ui/icons';
import type { TaskConversationContext, TaskConversationRequest } from '../state/taskConversationState';
import type { TaskReportState } from '../state/taskDetailState';
import { TaskCancelButton } from '../state/TaskCancellation';
import { CoordinationDetails } from './CoordinationDetails';
import '../styles/bot-task-detail.css';

export function SessionDetail({
  workspaceId,
  workspacePath,
  session,
  i18n,
  isZh,
  onBack,
  onConversation,
  botName,
  context,
  reportState,
  hasReadReport,
  onRetryReport,
  onSelect,
}: {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly session: DrawerSession;
  readonly i18n: I18nRuntime;
  readonly isZh: boolean;
  readonly onBack: () => void;
  readonly onConversation: (request: Omit<TaskConversationRequest, 'id'>) => void;
  readonly botName: string;
  readonly context: TaskConversationContext | null;
  readonly reportState: TaskReportState;
  readonly hasReadReport: boolean;
  readonly onRetryReport: () => void;
  readonly onSelect?: (sessionId:string)=>void;
}) {
  const [sceneOpen, setSceneOpen] = useState(false);
  const status = WORK_SESSION_STATUSES.find(value => value === session.status);
  const label = session.coordination?.phase === 'stopping' ? formatDrawerSessionStatus(session,i18n) : status === 'waiting_user' ? i18n.t('projectAgent.chat.work.waiting')
    : status === 'result_ready' ? i18n.t('projectAgent.chat.work.resultReady')
    : status ? i18n.t(`projectAgent.chat.sessionState.${status}`) : i18n.t('projectAgent.chat.work.unavailable');
  const progress = status === 'cancelled' ? label : formatDrawerSessionStatus(session, i18n);
  const stamp = formatDrawerStamp(session.spawnedAt);
  const hint = session.status === 'waiting_user' || session.status === 'result_ready' ? 'confirm'
    : session.status === 'failed' || session.status === 'unavailable' ? 'failed'
    : session.status === 'accepted' || session.status === 'cancelled' ? 'ended' : 'working';
  const question = ['waiting_user', 'result_ready'].includes(session.status) ? context?.question : null;
  const ended = session.status === 'accepted' || session.status === 'cancelled';
  const title = session.title && session.title !== session.sessionId ? session.title : i18n.t('projectAgent.chat.work.related');
  const messageId = context?.messageId || session.anchorMessageId || undefined;
  const updateText = context?.content.replace(/\s+/g, ' ').trim() ?? '';
  const updatePreview = updateText.length > 240 ? `${updateText.slice(0, 240)}…` : updateText;
  return (
    <div className="bot-drawer-detail bot-task-detail" data-status={session.status}>
      <button type="button" className="bot-task-back" onClick={onBack}><PeerIcon name="back" size={14} />{i18n.t('projectAgent.drawer.back')}</button>
      <header className="bot-task-detail-head">
        <h2>{title}</h2>
        <div className="bot-task-detail-meta"><span className="bot-task-status">{label}</span>
          {stamp && <time dateTime={session.spawnedAt}>{i18n.t('projectAgent.drawer.task.created', { time: stamp })}</time>}
        </div>
      </header>
      <TaskCancelButton sessionId={session.sessionId} status={session.status} title={title} i18n={i18n} />
      <section className="bot-task-progress" aria-label={i18n.t('projectAgent.drawer.progress')}>
        <h3>{i18n.t('projectAgent.drawer.progress')}</h3>
        <p className="bot-task-progress-text">{progress && progress !== session.status ? progress : label}</p>
        <p className="bot-task-hint">{i18n.t(`projectAgent.drawer.task.hint.${hint}`, { name: botName })}</p>
      </section>
      <section className="bot-task-next">
        <h3>{i18n.t(question ? 'projectAgent.drawer.task.question' : ended ? 'projectAgent.drawer.task.followUpEnded' : 'projectAgent.drawer.task.followUp', { name: botName })}</h3>
        {question ? <p className="bot-task-question">{question.content}</p>
          : <p className="bot-task-hint">{i18n.t(ended ? 'projectAgent.drawer.task.endedQuestion' : 'projectAgent.drawer.task.noQuestion', { name: botName })}</p>}
        <button type="button" className="bot-task-conversation" onClick={() => onConversation(question
          ? { messageId, cardId: question.cardId }
          : { messageId, taskTitle: title, draft: i18n.t(ended ? 'projectAgent.drawer.task.askEndedDraft' : 'projectAgent.drawer.task.askDraft', { title }) })}>
          {i18n.t(question ? 'projectAgent.drawer.task.answer' : ended ? 'projectAgent.drawer.task.askEnded' : 'projectAgent.drawer.task.ask', { name: botName })}
          <PeerIcon name="arrowUpRight" size={13} />
        </button>
        {!question && <p className="bot-task-action-note">{i18n.t('projectAgent.drawer.task.draftHint')}</p>}
      </section>
      {!question && context?.content ? <section className="bot-task-update">
        <div className="bot-task-update-head"><h3>{i18n.t('projectAgent.drawer.task.update', { name: botName })}</h3>
          <time dateTime={context.createdAt}>{formatDrawerStamp(context.createdAt)}</time></div>
        <p className="bot-task-update-preview">{updatePreview}</p>
        <button type="button" className="bot-task-conversation" onClick={() => onConversation({ messageId: context.messageId })}>
          {i18n.t('projectAgent.drawer.task.viewUpdate')}<PeerIcon name="arrowUpRight" size={13} />
        </button>
      </section> : null}
      <details className="bot-task-information" key={session.sessionId}>
        <summary><PeerIcon name="chevronRight" size={13} />{i18n.t('projectAgent.drawer.task.information')}</summary>
        <CoordinationDetails session={session} i18n={i18n} onSelect={onSelect} />
        <div className="bot-task-report-read" aria-busy={reportState === 'loading'}>
          {reportState !== 'ready' || !session.summary ? <p role="status">{i18n.t(reportState === 'loading'
            ? 'projectAgent.drawer.task.readingReport' : reportState === 'unavailable'
              ? hasReadReport ? 'projectAgent.drawer.task.reportStale' : 'projectAgent.drawer.task.reportUnavailable'
              : 'projectAgent.drawer.task.noReport')}</p> : null}
          {reportState === 'unavailable' && <button type="button" onClick={onRetryReport}>{i18n.t('projectAgent.background.retry')}</button>}
        </div>
        {session.summary && <section className="bot-task-instructions"><h3>{i18n.t('projectAgent.drawer.task.instructions')}</h3><p>{session.summary}</p></section>}
        <dl>
          {session.modelLabel && <div><dt>{i18n.t('projectAgent.drawer.frozenModel')}</dt><dd>{session.modelLabel}</dd></div>}
          <div><dt>{i18n.t('projectAgent.drawer.task.id')}</dt><dd><code>{session.sessionId}</code></dd></div>
          {session.anchorMessageId && <div><dt>{i18n.t('projectAgent.drawer.anchor')}</dt><dd><code>{session.anchorMessageId}</code></dd></div>}
          {session.evidenceRefs.length > 0 && <div><dt>{i18n.t('projectAgent.drawer.task.records', { count: session.evidenceRefs.length })}</dt>
            <dd><ul>{session.evidenceRefs.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul></dd></div>}
        </dl>
        {session.conversationId && <button type="button" className="bot-task-scene" onClick={() => setSceneOpen(true)}>
          <PeerIcon name="terminal" size={14} />{i18n.t('projectAgent.drawer.openScene')}
        </button>}
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
