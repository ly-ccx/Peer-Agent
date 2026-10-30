import type { I18nRuntime } from '@peer-agent/i18n';
import { generateAvatar, type BotProfile, type BotAvatar as BotAvatarModel, type InputDraftValue } from '@peer-agent/protocol';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { BotInspect } from '../drawer/agentProcess';
import type { BotAvatarMood } from '../state/botAvatarState';
import { replyRowContains, replyRowMood, replyRowRunning } from '../state/botReplyContinuity';
import { quoteRefsFor } from '../state/botConversationState';
import { replyDetailsRow } from '../state/botActivityState';
import { useReplyDetailsRow } from '../state/useReplyDetailsRow';
import { ReplyDetails } from './ReplyDetails';
import { useBotConversation } from '../state/useBotConversation';
import type { BotModelsControlState } from '../state/useBotModels';
import { DelegatedWork } from './DelegatedWork';
import { backgroundWork, type BotWorkIndex } from '../state/botWorkState';
import { BotConversationComposer } from './BotConversationComposer';
import { BotMessageList } from './BotMessageList';
import { BotRecoveryControl } from './BotRecoveryControl';
import { botAvatarDisplayColor } from '../BotAvatar';
import { BotInputContext } from './BotInputContext';
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
  onReplyPresenceChange,
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
  readonly onReplyPresenceChange?: (workspaceId: string, mood: BotAvatarMood | null) => void;
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
  const activeReply = [...conversation.viewRows].reverse().find(row => row.type === 'reply' && replyRowRunning(row));
  const replyMood = activeReply?.type === 'reply' ? replyRowMood(activeReply) : 'idle';
  useEffect(() => {
    onReplyPresenceChange?.(workspaceId, replyMood !== 'idle' || conversation.status === 'ready' ? replyMood : null);
  }, [workspaceId, conversation.status, replyMood, onReplyPresenceChange]);
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
  const [highlightedId, setHighlightedId] = useState<string | null>(focusMessageId ?? null);
  const [highlightRequestId, setHighlightRequestId] = useState(0);
  useEffect(() => {
    if (focusMessageId) { setHighlightedId(focusMessageId); setHighlightRequestId(value => value + 1); }
  }, [focusMessageId, focusRequestId]);
  const setQuote = (quote: InputDraftValue['quote']) => conversation.recovery.session.edit({ quote });
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

  const recoveryNeeded = conversation.status === 'ready' && Boolean(conversation.runtimeRecovery || conversation.recoveryAttention);
  const [recoveryShown, setRecoveryShown] = useState(recoveryNeeded);
  // Facts open the entry; it stays mounted while its exit closes the footprint.
  if (recoveryNeeded && !recoveryShown) setRecoveryShown(true);

  const background = useMemo(() => backgroundWork(workIndex), [workIndex]);
  const detailsRow = useMemo(() => replyDetailsRow(replyDetailsId, conversation.rows, conversation.messages),
    [replyDetailsId, conversation.rows, conversation.messages]);
  const details = useReplyDetailsRow(workspaceId, replyDetailsId, detailsRow);
  const detailsKey = detailsRow?.type === 'activity' ? detailsRow.activity.turnId
    : detailsRow?.type === 'message' ? detailsRow.message.turnId ?? detailsRow.message.id : replyDetailsId ?? '';
  const relatedReply = conversation.viewRows.find(row => row.type === 'reply' && replyRowContains(row, replyDetailsId));
  const relatedTurns = relatedReply?.type === 'reply' ? [...new Set([
    ...relatedReply.messages.map(message => message.turnId || message.id), ...(relatedReply.activity ? [relatedReply.activity.turnId] : []),
  ])].filter(id => id !== detailsKey) : [];
  const [detailsOpen, setDetailsOpen] = useState<Record<string, Record<string, boolean>>>({});
  const detailsDisclosure = { open: detailsOpen[detailsKey] ?? { main: true }, toggle: (key: string, value: boolean) => {
    setDetailsOpen(current => current[detailsKey]?.[key] === value ? current : {
      ...Object.fromEntries(Object.entries(current).slice(-31)),
      [detailsKey]: { main: true, ...current[detailsKey], [key]: value },
    });
  } };
  const openEvidence = (evidenceRef: string) => onInspect?.({ replyId: replyDetailsId ?? undefined,
    evidence: { ok: false, evidenceRef, kind: 'observation', summary: '', truncated: false, code: '' }, rounds: null });

  return (
    <BotInputContext.Provider value={conversation.answer}>
    <div className="bot-convo" style={{
      '--bot-message-accent': botAvatarDisplayColor(avatar.kind === 'generated' ? avatar.color : generateAvatar(workspaceId).color),
    } as CSSProperties}>
      {replyDetailsId && replyDetailsTarget ? createPortal(<ReplyDetails key={replyDetailsId} row={details.row} loading={details.loading}
        workspaceId={workspaceId} botName={label} workIndex={workIndex} i18n={i18n}
        disclosure={detailsDisclosure}
        relatedTurns={relatedTurns} onOpenRelatedReply={id => onInspect?.({ replyId: id, evidence: null, rounds: null })}
        onOpenEvidence={openEvidence} onOpenWork={onLocateSession} />, replyDetailsTarget) : null}
      {recoveryShown ? <BotRecoveryControl key={workspaceId} workspaceId={workspaceId} status={conversation.runtimeRecovery} settled={!recoveryNeeded}
        i18n={i18n} onRetry={conversation.reload} onClosed={() => setRecoveryShown(false)} /> : null}
      {conversation.status === 'ready' && (conversation.cardsError && !conversation.runtimeRecovery || conversation.refreshError || conversation.catchUpRequired) ? <div className="bot-thread-feedback" role="status">
        <div>
          {conversation.catchUpRequired ? <p>{i18n.t('resources.catchUp')}</p> : null}
          {conversation.cardsError && !conversation.runtimeRecovery ? <p>{i18n.t('projectAgent.chat.cardsUnavailable')}</p> : null}
          {conversation.refreshError ? <p>{i18n.t('projectAgent.chat.refreshFailed')}</p> : null}
        </div>
        <button type="button" onClick={conversation.reload}>{i18n.t(conversation.catchUpRequired ? 'resources.continueRead' : 'projectAgent.history.retry')}</button>
      </div> : null}
      {conversation.status === 'error' ? (
        <div className="bot-thread-failed" role="status">
          <p className="bot-thread-error">{i18n.t('projectAgent.chat.loadFailed')}</p>
          <button type="button" onClick={conversation.reload}>{i18n.t(conversation.catchUpRequired ? 'resources.continueRead' : 'projectAgent.history.retry')}</button>
        </div>
      ) : (
        <BotMessageList key={`thread:${workspaceId}`} ready={conversation.status === 'ready'} locateMessage={conversation.locateMessage}
          workspaceId={workspaceId}
          workIndex={workIndex}
          avatar={avatar}
          label={label}
          avatarMood={avatarMood}
          rows={conversation.viewRows}
          followRequestId={conversation.followRequestId}
          onReload={conversation.reload}
          hasOlder={conversation.hasOlder}
          olderError={conversation.olderError}
          onLoadOlder={conversation.loadOlder}
          highlightedId={highlightedId}
          highlightRequestId={highlightRequestId}
          focusTaskRequest={taskRequest?.draft ? null : taskRequest}
          i18n={i18n}
          onJump={(messageId) => { setHighlightedId(messageId); setHighlightRequestId(value => value + 1); }}
          onQuote={(messageId, excerpt) => {
            const [sourceId, text] = quoteRefsFor(messageId, excerpt);
            if (sourceId && text) setQuote({ messageId: sourceId, text });
          }}
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
      {background.count ? <details className="bot-background-work">
        <summary>
          <span>{i18n.t('projectAgent.chat.work.background', { count: background.count })}</span>
          <PeerIcon name="chevronDown" size={12} />
        </summary>
        <DelegatedWork rows={background.rows} botName={label} i18n={i18n} onOpen={onLocateSession} />
      </details> : null}
      <BotConversationComposer key={`composer:${workspaceId}`} workspaceId={workspaceId}
        conversation={conversation} profile={profile} modelControls={modelControls} label={label} i18n={i18n} taskRequest={taskRequest}
        onJump={messageId => { setHighlightedId(messageId); setHighlightRequestId(value => value + 1); }} />
    </div>
    </BotInputContext.Provider>
  );
}
