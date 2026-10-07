import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useRef, useState } from 'react';
import type { TaskConversationRequest } from '../state/taskConversationState';
import {
  formatConversationStamp,
  repliedUserIds,
  type BotChatMessage,
  type ConversationRow,
  type ConversationDisplayRow,
  type BotToolRound,
} from '../state/botConversationState';
import { BotAvatar } from '../BotAvatar';
import type { BotAvatarMood } from '../state/botAvatarState';
import { CardView } from './CardView';
import { ReplyBubble } from './ReplyBubble';
import { UserBubble } from './UserBubble';
import { conversationRowKey, useConversationWindow } from './useConversationWindow';
import { LiveReply } from './LiveReply';
import { ReplyAnchors } from './ReplyAnchors';
import { PeerIcon } from '../../ui/icons';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { replyAnchorsForMessages, replyReferencesForRows, type ReplyAnchor } from '../state/replyReferenceState';
import { useMessageHighlight } from './useMessageHighlight';
import { BotNarration } from './BotNarration';
import type { BotNarrationSegment } from '../state/botNarrationState';
import { ReplyContext } from './ReplyContext';

export function BotMessageList({
  workspaceId,
  avatar,
  label,
  avatarMood,
  rows,
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
  waiting = false,
  focusTaskRequest = null,
}: {
  readonly workspaceId: string;
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly avatarMood: BotAvatarMood;
  readonly rows: readonly ConversationDisplayRow[];
  readonly followRequestId?: number;
  readonly waiting?: boolean;
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
}) {
  const loadingOlderRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scroll = useConversationWindow(rows, highlightedId, highlightRequestId, followRequestId);
  const taskMessageVisible = scroll.visibleRows.some(row => row.type === 'message' && row.message.id === focusTaskRequest?.messageId);
  useEffect(() => {
    if (!focusTaskRequest?.messageId || !taskMessageVisible) return;
    const root = scroll.scrollerRef.current;
    const message = root?.querySelector<HTMLElement>(`#${CSS.escape(`bot-msg-${focusTaskRequest.messageId}`)}`);
    const card = focusTaskRequest.cardId
      ? message?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(focusTaskRequest.cardId)}"] button:not(:disabled)`)
      : null;
    const target = card ?? message;
    if (target) { if (!card) target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, [focusTaskRequest, taskMessageVisible, scroll.scrollerRef]);
  const highlighted = useMessageHighlight(highlightedId, highlightRequestId, scroll.visibleRows.some(row => row.type === 'message' && row.message.id === highlightedId));
  const references = replyReferencesForRows(rows);
  const messages = rows.flatMap((row) => (row.type === 'message' ? [row.message] : []));
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
    <div
      className="bot-thread"
      data-single-system={rows.length === 1 && rows[0]?.type === 'message' && rows[0].message.kind === 'system_card'
        && !rows[0].message.cards.some(card => card.kind === 'familiarize') ? 'true' : undefined}
      ref={scroll.scrollerRef}
      role="log"
      aria-live="polite"
      aria-busy={loadingOlder}
      onScroll={(event) => {
        const node = event.currentTarget;
        scroll.onScroll();
        if (node.scrollTop < 48 && hasOlder && !olderError) {
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
        <div key={conversationRowKey(row)} className="bot-thread-row" data-conversation-row={conversationRowKey(row)}>
        {row.type === 'activity' || row.type === 'message' && (row.message.kind === 'agent_reply'
          || row.message.cards.some(card => card.kind === 'agent_stopped' || card.kind === 'agent_unavailable')) ? (
          <div className="bot-message-author"><BotAvatar avatar={avatar} label={label} workspaceId={workspaceId} mood={avatarMood} /><span>{label}</span></div>
        ) : null}
        {row.type === 'activity' ? <LiveReply referenceIds={references.get(row) ?? []} activity={row.activity} i18n={i18n} anchors={anchors} onJump={onJump} onOpenDetails={onOpenDetails ? () => onOpenDetails(row.activity.turnId) : undefined} /> : row.type === 'separator' ? (
          <p key={row.id} className="bot-separator">{separatorText(row, i18n)}</p>
        ) : row.message.kind === 'user_input' ? (
          <UserBubble
            key={row.message.id}
            message={row.message}
            replied={replied.has(row.message.id)}
            anchors={anchors}
            onJump={onJump}
            highlighted={highlighted === row.message.id}
            i18n={i18n}
            onRetry={onRetry}
            onLocateSession={onLocateSession}
          />
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
        </div>
      ))}
      {scroll.view.after > 0 ? (
        <div className="bot-thread-spacer" style={{ height: scroll.view.after }} />
      ) : null}
      {waiting ? <p className="bot-live-status" role="status">{i18n.t('projectAgent.chat.waiting')}</p> : null}
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
  return (
    <div className={`bot-system${welcome ? ' bot-system-welcome' : ''}${highlighted ? ' is-anchored' : ''}`} id={`bot-msg-${message.id}`}>
      {welcome ? <BotAvatar avatar={avatar} label={label} workspaceId={workspaceId} mood={avatarMood} /> : null}
      <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} />
      <BotNarration segments={narration} />
      <CardView workspaceId={workspaceId} cards={cards} i18n={i18n} />
      {!welcome && (activity || processRounds?.length || cards.some(card => card.kind === 'agent_stopped' || card.kind === 'agent_unavailable')) ?
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
