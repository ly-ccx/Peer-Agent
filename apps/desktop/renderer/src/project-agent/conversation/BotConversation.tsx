import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotProfile, BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clientApi } from '../../clientApi';
import type { BotInspect } from '../drawer/agentProcess';
import type { BotAvatarMood } from '../state/botAvatarState';
import { quoteRefsFor } from '../state/botConversationState';
import { replyAnchorsForMessages } from '../state/replyReferenceState';
import { ReplyDetails } from './ReplyDetails';
import { useBotConversation } from '../state/useBotConversation';
import { BotModelControls } from '../BotModelControls';
import type { BotModelsControlState } from '../state/useBotModels';
import { DelegatedWork } from './DelegatedWork';
import { backgroundWork, type BotWorkIndex } from '../state/botWorkState';
import { BotComposer } from './BotComposer';
import { BotMessageList } from './BotMessageList';
import '../styles/bot-conversation.css';
import { PeerIcon } from '../../ui/icons';
import { taskConversationContext, type TaskConversationContext, type TaskConversationRequest } from '../state/taskConversationState';

export function BotConversation({
  workspaceId,
  workIndex,
  profile,
  modelControls,
  avatar,
  label,
  avatarMood,
  i18n,
  onReplyArrived,
  onLocateSession,
  onInspect,
  focusMessageId = null,
  focusRequestId = 0,
  contextSessionId = null,
  onTaskContext,
  taskRequest = null,
  replyDetailsId = null,
  replyDetailsTarget = null,
}: {
  readonly workspaceId: string;
  readonly workIndex: BotWorkIndex;
  readonly profile: BotProfile;
  readonly modelControls: BotModelsControlState;
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly avatarMood: BotAvatarMood;
  readonly i18n: I18nRuntime;
  readonly onReplyArrived?: (workspaceId: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
  readonly onInspect?: (inspect: BotInspect) => void;
  readonly focusMessageId?: string | null;
  readonly focusRequestId?: number;
  readonly contextSessionId?: string | null;
  readonly onTaskContext?: (context: TaskConversationContext | null) => void;
  readonly taskRequest?: TaskConversationRequest | null;
  readonly replyDetailsId?: string | null;
  readonly replyDetailsTarget?: HTMLElement | null;
}) {
  const conversation = useBotConversation(workspaceId);
  const lastReplyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (conversation.status !== 'ready') return;
    const replies = conversation.messages.filter((message) => message.kind === 'agent_reply');
    const lastId = replies[replies.length - 1]?.id ?? null;
    if (lastReplyRef.current !== undefined && lastId && lastId !== lastReplyRef.current) {
      onReplyArrived?.(workspaceId);
    }
    lastReplyRef.current = lastId;
  }, [conversation.status, conversation.messages, onReplyArrived, workspaceId]);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [highlightRequestId, setHighlightRequestId] = useState(0);
  useEffect(() => {
    if (highlightedId) void conversation.locateMessage(highlightedId);
  }, [highlightedId, conversation.locateMessage]);
  useEffect(() => {
    if (focusMessageId) { setHighlightedId(focusMessageId); setHighlightRequestId(value => value + 1); }
  }, [focusMessageId, focusRequestId]);
  const [quote, setQuote] = useState<{ messageId: string; text: string } | null>(null);
  const quotedMessage = quote ? conversation.messages.find(message => message.id === quote.messageId) : undefined;
  const quoteSource = quotedMessage ? replyAnchorsForMessages([quotedMessage], {
    user: i18n.t('projectAgent.chat.you'), bot: label,
  }).get(quotedMessage.id)?.author : null;
  const context = useMemo(() => taskConversationContext(workspaceId, contextSessionId, conversation.messages, workIndex),
    [workspaceId, contextSessionId, conversation.messages, workIndex]);
  const publishedContext = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = JSON.stringify(context);
    if (publishedContext.current === key) return;
    publishedContext.current = key;
    onTaskContext?.(context);
  }, [context, onTaskContext]);
  useEffect(() => {
    if (!taskRequest) return;
    if (taskRequest.messageId) {
      setHighlightedId(taskRequest.messageId);
      setHighlightRequestId(value => value + 1);
    }
  }, [taskRequest]);

  const background = useMemo(() => backgroundWork(workIndex), [workIndex]);
  const runningWork = background.rows.find(row => ['starting', 'running', 'verifying'].includes(row.status ?? ''));
  const detailsRow = conversation.rows.find(row => row.type === 'message' && row.message.id === replyDetailsId)
    ?? [...conversation.rows].reverse().find(row => row.type === 'activity' ? row.activity.turnId === replyDetailsId
      : row.type === 'message' && row.message.turnId === replyDetailsId);
  const detailsKey = detailsRow?.type === 'activity' ? detailsRow.activity.turnId
    : detailsRow?.type === 'message' ? detailsRow.message.turnId ?? detailsRow.message.id : replyDetailsId ?? '';
  const [detailsOpen, setDetailsOpen] = useState<Record<string, Record<string, boolean>>>({});
  const detailsDisclosure = { open: detailsOpen[detailsKey] ?? { main: true }, toggle: (key: string, value: boolean) => {
    setDetailsOpen(current => current[detailsKey]?.[key] === value ? current : {
      ...Object.fromEntries(Object.entries(current).slice(-31)),
      [detailsKey]: { main: true, ...current[detailsKey], [key]: value },
    });
  } };
  const openEvidence = (evidenceRef: string) => {
    void clientApi.projectAgentReadEvidence({ evidenceRef }).then(result => onInspect?.({
      replyId: replyDetailsId ?? undefined,
      evidence: { ...result, ok: result?.ok === true, evidenceRef: result?.evidenceRef || evidenceRef,
        kind: result?.kind || 'command', summary: result?.summary || '', truncated: result?.truncated === true, code: result?.code || '' },
      rounds: null,
    })).catch(() => onInspect?.({ replyId: replyDetailsId ?? undefined,
      evidence: { ok: false, evidenceRef, kind: 'command', summary: '', truncated: false, availability: 'unavailable', code: 'READ_FAILED' }, rounds: null }));
  };

  return (
    <div className="bot-convo">
      {replyDetailsId && replyDetailsTarget ? createPortal(<ReplyDetails key={replyDetailsId} row={detailsRow}
        workspaceId={workspaceId} botName={label} workIndex={workIndex} i18n={i18n}
        disclosure={detailsDisclosure}
        onOpenEvidence={openEvidence} onOpenWork={onLocateSession} />, replyDetailsTarget) : null}
      {conversation.status === 'error' ? (
        <p className="bot-thread-error">{i18n.t('projectAgent.chat.loadFailed')}</p>
      ) : (
        <BotMessageList
          workspaceId={workspaceId}
          avatar={avatar}
          label={label}
          avatarMood={avatarMood}
          rows={conversation.rows}
          followRequestId={conversation.followRequestId}
          waiting={conversation.thinking}
          hasOlder={conversation.hasOlder}
          olderError={conversation.olderError}
          onLoadOlder={conversation.loadOlder}
          highlightedId={highlightedId}
          highlightRequestId={highlightRequestId}
          focusTaskRequest={taskRequest?.draft ? null : taskRequest}
          i18n={i18n}
          onJump={(messageId) => { setHighlightedId(messageId); setHighlightRequestId(value => value + 1); }}
          onQuote={(messageId, excerpt) => setQuote({ messageId, text: excerpt })}
          onRetry={(inputId) => {
            void conversation.retry(inputId);
          }}
          onLocateSession={onLocateSession}
          onOpenDetails={(replyId) => {
            onInspect?.({
              replyId,
              evidence: null,
              rounds: null,
            });
          }}
        />
      )}
      {conversation.stopError ? <p className="bot-thread-error" role="alert">{i18n.t('projectAgent.chat.stopFailed')}</p> : null}
      {modelControls.error ? <p className="bot-model-error" role="alert">{i18n.t('projectAgent.model.saveFailed')}</p> : null}
      {background.count ? <details className="bot-background-work"><summary>
        {runningWork?.status ? <><PeerIcon name="terminal" size={14} /><span className="bot-work-title">{runningWork.session?.title || i18n.t('projectAgent.chat.work.related')}</span>
          <span className="bot-work-status is-running">{i18n.t(`projectAgent.chat.sessionState.${runningWork.status}`)}</span></>
          : <span>{i18n.t('projectAgent.chat.work.background', { count: background.count })}</span>}<PeerIcon name="chevronDown" size={12} /></summary>
        <DelegatedWork rows={background.rows} botName={label} i18n={i18n} onOpen={onLocateSession} /></details> : null}
      <BotComposer
        key={workspaceId}
        i18n={i18n}
        botName={label}
        modelUpdating={modelControls.busy}
        draftRequest={taskRequest?.draft ? { id: taskRequest.id, text: taskRequest.draft } : null}
        onDraftPrepared={id => {
          if (taskRequest?.id === id && taskRequest.messageId && taskRequest.taskTitle) {
            setQuote({ messageId: taskRequest.messageId, text: taskRequest.taskTitle });
          }
        }}
        modelControls={<div className="bot-model-toolbar"><BotModelControls role="project_agent" compact
          policy={profile.modelPolicy} models={modelControls.models} view={modelControls.views.project_agent}
          activeSelection={conversation.activeModelSelection} busy={modelControls.busy || conversation.generating}
          i18n={i18n} onChange={policy => modelControls.save(policy)} /></div>}
        quote={quote?.text ?? ''}
        quoteSource={quoteSource}
        generating={conversation.generating}
        stopping={conversation.stopping}
        onStop={() => void conversation.stop()}
        onQuoteRemove={() => setQuote(null)}
        onSend={(text, attachments) => {
          const refs = quote ? quoteRefsFor(quote.messageId, quote.text) : [];
          setQuote(null);
          void conversation.send(text, refs, attachments);
        }}
      />
    </div>
  );
}
