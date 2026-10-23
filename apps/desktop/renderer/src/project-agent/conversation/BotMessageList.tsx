import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { TaskConversationRequest } from '../state/taskConversationState';
import {
  formatConversationStamp,
  repliedUserIds,
  type BotChatMessage,
  type ConversationRow,
  type BotToolRound,
} from '../state/botConversationState';
import { BotAvatar } from '../BotAvatar';
import type { BotAvatarMood } from '../state/botAvatarState';
import { CardView } from './CardView';
import { ReplyBubble } from './ReplyBubble';
import { UserBubble } from './UserBubble';
import { ConversationRow as ConversationRowView } from './ConversationRow';
import { conversationRowKey, useConversationWindow } from './useConversationWindow';
import { ContinuousReply } from './ContinuousReply';
import { replyRowContains, replyRowRunning, replyRowMood, type BotConversationViewRow } from '../state/botReplyContinuity';
import { ReplyAnchors } from './ReplyAnchors';
import { PeerIcon } from '../../ui/icons';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { replyAnchorsForMessages, replyReferencesForRows, type ReplyAnchor } from '../state/replyReferenceState';
import { useMessageHighlight } from './useMessageHighlight';
import { BotNarration } from './BotNarration';
import type { BotNarrationSegment } from '../state/botNarrationState';
import { ReplyContext } from './ReplyContext';
import { AgentActivityRow } from './AgentActivityRow';
import { RecoveryHistory } from './RecoveryHistory';
import { isRetiredRecovery, agentFailurePresentation } from '../state/recoveryPresentation';

export function BotMessageList({
  workspaceId,
  avatar,
  label,
  avatarMood,
  rows,
  ready, locateMessage,
  hasOlder = false,
  olderError = false,
  onLoadOlder,
  highlightedId,
  highlightRequestId = 0,
  i18n,
  onJump,
  onQuote,
  onRetry,
  onLocateSession,
  onOpenDetails,
  followRequestId = 0,
  onReload = () => {},
  focusTaskRequest = null,
  trailing = null,
}: {
  readonly workspaceId: string;
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly avatarMood: BotAvatarMood;
  readonly rows: readonly BotConversationViewRow[];
  readonly ready: boolean;
  readonly locateMessage: (id: string, pages: number, active: () => boolean) => Promise<boolean>;
  readonly followRequestId?: number;
  readonly onReload?: () => void;
  readonly hasOlder?: boolean;
  readonly olderError?: boolean;
  readonly onLoadOlder?: () => Promise<void>;
  readonly highlightedId: string | null;
  readonly highlightRequestId?: number;
  readonly i18n: I18nRuntime;
  readonly onJump: (messageId: string) => void;
  readonly onQuote: (messageId: string, excerpt: string) => void;
  readonly onRetry: (inputId: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
  readonly onOpenDetails?: (replyId: string) => void;
  readonly focusTaskRequest?: TaskConversationRequest | null;
  /** Sits with the latest line. Kept inside the thread so the unused scroll area cannot open a gap above it. */
  readonly trailing?: ReactNode;
}) {
  const loadingOlderRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const previousRows = useRef({ keys: new Set(rows.map(conversationRowKey)), followRequestId });
  const followingNewInput = previousRows.current.followRequestId !== followRequestId;
  useLayoutEffect(() => { previousRows.current = { keys: new Set(rows.map(conversationRowKey)), followRequestId }; }, [rows, followRequestId]);
  const scroll = useConversationWindow(rows, highlightedId, highlightRequestId, followRequestId, { identity: workspaceId, ready, hasOlder, locateMessage });
  const focusedRequest = useRef<{ key: string; epoch: number; done: boolean } | null>(null);
  const focusKey = focusTaskRequest?.messageId ? `${workspaceId}:${focusTaskRequest.id}:${focusTaskRequest.messageId}:${focusTaskRequest.cardId}` : null;
  if (focusKey && focusedRequest.current?.key !== focusKey) focusedRequest.current = { key: focusKey, epoch: scroll.navigationEpoch, done: false };
  const taskMessageVisible = scroll.visibleRows.some(row => replyRowContains(row, focusTaskRequest?.messageId));
  useEffect(() => {
    if (!focusTaskRequest?.messageId || !taskMessageVisible) return;
    const request = focusedRequest.current;
    if (!request || request.done || request.epoch !== scroll.navigationEpoch) return;
    const root = scroll.scrollerRef.current;
    const message = root?.querySelector<HTMLElement>(`#${CSS.escape(`bot-msg-${focusTaskRequest.messageId}`)}`);
    const card = focusTaskRequest.cardId
      ? message?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(focusTaskRequest.cardId)}"] button:not(:disabled)`)
      : null;
    const target = card ?? message;
    if (target) { request.done = true; if (!card) target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, [focusTaskRequest, taskMessageVisible, scroll.scrollerRef]);
  const highlighted = useMessageHighlight(highlightedId, highlightRequestId, scroll.visibleRows.some(row => replyRowContains(row, highlightedId)));
  const references = replyReferencesForRows(rows);
  const messages = rows.flatMap(row => row.type === 'reply' ? [...row.messages] : row.type === 'message' ? [row.message] : []);
  const anchors = replyAnchorsForMessages(messages, { user: i18n.t('projectAgent.chat.you'), bot: label });
  const replied = repliedUserIds(messages);
  const loadOlder = async () => {
    if (!onLoadOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    scroll.holdPosition();
    try { await onLoadOlder(); }
    finally {
      requestAnimationFrame(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
    }
  };

  return (
    <div className="bot-thread-shell">
    {scroll.referenceStatus !== 'none' ? <div className="bot-thread-feedback" role="status">
      <p>{i18n.t(scroll.referenceStatus === 'loading' ? 'resources.locating' : 'resources.sourceUnavailable')}</p>
      {scroll.referenceStatus !== 'loading' ? <button type="button" onClick={() => void scroll.locateReference()}>{i18n.t('resources.retryRead')}</button> : null}
    </div> : null}
    {scroll.restoreStatus !== 'none' ? <div className="bot-thread-feedback" role="status">
      <p>{i18n.t(scroll.restoreStatus === 'loading' ? 'projectAgent.chat.restoringReading' : 'projectAgent.chat.readingUnavailable')}</p>
      {scroll.restoreStatus !== 'loading' ? <button type="button" onClick={() => void scroll.restoreReading()}>{i18n.t('projectAgent.chat.restoreReading')}</button> : null}
    </div> : null}
    <div
      className="bot-thread"
      data-single-system={rows.length === 1 && rows[0]?.type === 'message' && rows[0].message.kind === 'system_card'
        && !rows[0].message.cards.some(card => card.kind === 'familiarize') ? 'true' : undefined}
      ref={scroll.scrollerRef}
      role="log"
      tabIndex={0}
      aria-live="polite"
      aria-busy={loadingOlder}
      onWheel={scroll.onWheel} onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove}
      onPointerDown={scroll.onPointerDown} onKeyDown={scroll.onKeyDown}
      onScroll={(event) => {
        const node = event.currentTarget;
        scroll.onScroll();
        if (scroll.wantsOlder() && node.scrollTop < 48 && hasOlder && !olderError) {
          void loadOlder();
        }
      }}
    >
      {hasOlder ? (
        <button className="bot-thread-older" type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {i18n.t(olderError ? 'projectAgent.chat.olderFailed' : loadingOlder ? 'projectAgent.chat.loadingOlder' : 'projectAgent.chat.loadOlder')}
        </button>
      ) : null}
      <div className="bot-thread-origin" ref={scroll.originRef} />
      {rows.length === 0 ? (
        <div className="bot-thread-empty">
          <BotAvatar avatar={avatar} label={label} workspaceId={workspaceId} mood={avatarMood} />
          <p>{i18n.t('projectAgent.chat.empty')}</p>
        </div>
      ) : null}
      {scroll.view.before > 0 ? <div className="bot-thread-spacer" style={{ height: scroll.view.before }} /> : null}
      {scroll.visibleRows.map((row) => (
        <ConversationRowView key={conversationRowKey(row)} rowKey={conversationRowKey(row)}
          entering={!previousRows.current.keys.has(conversationRowKey(row)) && (row.type === 'reply'
            ? Boolean(row.pending && !row.pending.restored && !row.pending.deliveryIssue)
            : row.type === 'message' && row.message.kind === 'user_input' && (['sending', 'received'].includes(row.message.pending ?? '') || followingNewInput))}
          className={`bot-thread-row${row.type === 'message' && isRetiredRecovery(row.message.cards) && !row.narration?.length ? ' is-recovery-history' : ''}`}>
        {row.type === 'reply' || row.type === 'message' && (['agent_reply', 'agent_turn'].includes(row.message.kind)
          || row.message.cards.some(card => card.kind === 'agent_stopped' || card.kind === 'agent_unavailable')
            && (!isRetiredRecovery(row.message.cards) || Boolean(row.narration?.length))) ? (
          <div className="bot-message-author"><BotAvatar avatar={avatar} label={label} workspaceId={workspaceId}
            animate={row.type === 'reply' && replyRowRunning(row)} mood={row.type === 'reply' ? replyRowMood(row) : 'idle'} /><span>{label}</span></div>
        ) : null}
        {row.type === 'reply' ? <ContinuousReply workspaceId={workspaceId} reply={row} referenceIds={references.get(row) ?? []}
          i18n={i18n} anchors={anchors} highlighted={replyRowContains(row, highlighted)} onJump={onJump} onQuote={onQuote}
          onReload={onReload} onOpenDetails={onOpenDetails} /> : row.type === 'separator' ? (
          <p key={row.id} className="bot-separator">{separatorText(row, i18n)}</p>
        ) : row.message.kind === 'user_input' ? (
          <UserBubble
            key={conversationRowKey(row)}
            message={row.message}
            replied={replied.has(row.message.id)}
            anchors={anchors}
            onJump={onJump}
            highlighted={highlighted === row.message.id}
            i18n={i18n}
            onRetry={onRetry}
            onLocateSession={onLocateSession}
          />
        ) : row.message.kind === 'agent_turn' ? (
          <article className="bot-reply" id={`bot-msg-${row.message.id}`}>
            <BotNarration segments={row.narration ?? []} />
            <ReplyContext i18n={i18n} onOpenDetails={onOpenDetails ? () => onOpenDetails(row.message.id) : undefined} />
          </article>
        ) : row.message.kind === 'agent_activity' ? (
          row.message.agentActivity ? <AgentActivityRow messageId={row.message.id} activity={row.message.agentActivity} i18n={i18n} onOpen={onLocateSession} /> : null
        ) : row.message.kind === 'system_card' ? (
          <SystemCard
            key={row.message.id}
            workspaceId={workspaceId}
            message={row.message}
            highlighted={highlighted === row.message.id}
            referenceIds={references.get(row) ?? []}
            activity={row.activity}
            processRounds={row.processRounds}
            narration={row.narration}
            anchors={anchors}
            onJump={onJump}
            onOpenDetails={onOpenDetails ? () => onOpenDetails(row.message.id) : undefined}
            welcome={rows.length === 1 && row.message.cards.some((card) => card.kind === 'familiarize')}
            avatar={avatar}
            label={label}
            avatarMood={avatarMood}
            i18n={i18n}
          />
        ) : (
          <ReplyBubble
            key={row.message.id}
            workspaceId={workspaceId}
            message={row.message}
            anchors={anchors}
            narration={row.narration}
            highlighted={highlighted === row.message.id}
            referenceIds={references.get(row) ?? []}
            i18n={i18n}
            onJump={onJump}
            onQuote={(excerpt) => onQuote(row.message.id, excerpt)}
            onOpenDetails={onOpenDetails ? () => onOpenDetails(row.message.id) : undefined}
          />
        )}
        </ConversationRowView>
      ))}
      {scroll.view.after > 0 ? (
        <div className="bot-thread-spacer" style={{ height: scroll.view.after }} />
      ) : null}
      <div className="bot-thread-tail" ref={scroll.tailRef}>{trailing}</div>
    </div>
    {!scroll.following ? <button type="button" className="bot-thread-latest" aria-label={i18n.t('projectAgent.chat.latest')} title={i18n.t('projectAgent.chat.latest')} onClick={scroll.followLatest}><PeerIcon name="chevronDown" size={18} /></button> : null}
    </div>
  );
}

function SystemCard({
  workspaceId,
  message,
  highlighted,
  referenceIds,
  welcome,
  anchors,
  onJump,
  onOpenDetails,
  activity,
  processRounds,
  narration = [],
  avatar,
  label,
  avatarMood,
  i18n,
}: {
  readonly workspaceId: string;
  readonly message: BotChatMessage;
  readonly highlighted: boolean;
  readonly referenceIds: readonly string[];
  readonly welcome: boolean;
  readonly onOpenDetails?: () => void;
  readonly activity?: ProjectAgentActivity;
  readonly processRounds?: readonly BotToolRound[];
  readonly narration?: readonly BotNarrationSegment[];
  readonly anchors: ReadonlyMap<string, ReplyAnchor>;
  readonly onJump: (id: string) => void;
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly avatarMood: BotAvatarMood;
  readonly i18n: I18nRuntime;
}) {
  const cards = message.cards.length > 0
    ? message.cards
    : [{ cardId: message.id, kind: 'system_card', content: message.content, actions: [] }];
  const retired = isRetiredRecovery(cards);
  return (
    <div className={`bot-system${welcome ? ' bot-system-welcome' : ''}${highlighted ? ' is-anchored' : ''}`} id={`bot-msg-${message.id}`}>
      {welcome ? <BotAvatar avatar={avatar} label={label} workspaceId={workspaceId} mood={avatarMood} /> : null}
      <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} />
      <BotNarration segments={narration} />
      {retired ? <RecoveryHistory messageKey={agentFailurePresentation(cards[0]).messageKey} createdAt={message.createdAt} highlighted={highlighted} i18n={i18n} onOpenDetails={onOpenDetails} />
        : <CardView workspaceId={workspaceId} cards={cards} i18n={i18n} />}
      {!welcome && !retired && (activity || processRounds?.length || cards.some(card => card.kind === 'agent_stopped' || card.kind === 'agent_unavailable')) ?
        <ReplyContext i18n={i18n} onOpenDetails={onOpenDetails} /> : null}
    </div>
  );
}

function separatorText(
  row: Extract<ConversationRow, { type: 'separator' }>,
  i18n: I18nRuntime,
): string {
  if (row.label) return row.label;
  const stamp = formatConversationStamp(row.at);
  const when = stamp
    ? (stamp.sameDay
      ? i18n.t('projectAgent.chat.today', { time: stamp.clock })
      : i18n.t('projectAgent.chat.earlierDay', { date: stamp.date, time: stamp.clock }))
    : '';
  if (row.proactive && when) return `${when} · ${i18n.t('projectAgent.chat.digest')}`;
  return when;
}
