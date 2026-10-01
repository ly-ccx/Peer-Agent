import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotAvatar as BotAvatarModel } from '@peer-agent/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  formatConversationStamp,
  conversationWindowAnchor,
  repliedUserIds,
  windowConversationRows,
  type BotChatMessage,
  type ConversationRow,
} from '../state/botConversationState';
import { BotAvatar } from '../BotAvatar';
import type { BotAvatarMood } from '../state/botAvatarState';
import { CardView } from './CardView';
import { ReplyBubble } from './ReplyBubble';
import { UserBubble } from './UserBubble';

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
  i18n,
  onJump,
  onQuote,
  onRetry,
  onLocateSession,
  onOpenEvidence,
  onOpenProcess,
}: {
  readonly workspaceId: string;
  readonly avatar: BotAvatarModel;
  readonly label: string;
  readonly avatarMood: BotAvatarMood;
  readonly rows: readonly ConversationRow[];
  readonly hasOlder?: boolean;
  readonly olderError?: boolean;
  readonly onLoadOlder?: () => Promise<void>;
  readonly highlightedId: string | null;
  readonly i18n: I18nRuntime;
  readonly onJump: (messageId: string) => void;
  readonly onQuote: (messageId: string, excerpt: string) => void;
  readonly onRetry: (inputId: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
  readonly onOpenEvidence?: (evidenceRef: string) => void;
  readonly onOpenProcess?: (replyId: string) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const loadingOlderRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [anchor, setAnchor] = useState(Math.max(0, rows.length - 1));
  const [viewportHeight, setViewportHeight] = useState(0);
  const previousRowsRef = useRef(rows);
  const messages = rows.flatMap((row) => (row.type === 'message' ? [row.message] : []));
  const anchors = new Map(messages.map((message) => [message.id, clip(message.content)]));
  const replied = repliedUserIds(messages);
  const windowSize = Math.max(80, Math.ceil(viewportHeight / 36) + 40);
  const windowed = windowConversationRows(rows, anchor, windowSize);
  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const measure = () => setViewportHeight(node.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const loadOlder = async () => {
    if (!onLoadOlder || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const node = scrollerRef.current;
    const previousHeight = node?.scrollHeight ?? 0;
    const previousTop = node?.scrollTop ?? 0;
    pinnedRef.current = false;
    try { await onLoadOlder(); }
    finally {
      requestAnimationFrame(() => {
        if (node) node.scrollTop = previousTop + Math.max(0, node.scrollHeight - previousHeight);
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
    }
  };

  useLayoutEffect(() => {
    const previous = previousRowsRef.current;
    setAnchor(current => pinnedRef.current ? Math.max(0, rows.length - 1) : conversationWindowAnchor(previous, rows, current));
    previousRowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    if (!highlightedId) return;
    const index = rows.findIndex((row) => row.type === 'message' && row.message.id === highlightedId);
    if (index >= 0) setAnchor(index);
    const node = document.getElementById(`bot-msg-${highlightedId}`);
    node?.scrollIntoView({ block: 'center' });
  }, [highlightedId, rows]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [windowed.start, windowed.rows.length, rows.length]);

  return (
    <div
      className="bot-thread"
      ref={scrollerRef}
      role="log"
      aria-live="polite"
      aria-busy={loadingOlder}
      onScroll={(event) => {
        const node = event.currentTarget;
        pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        if (rows.length > 200) {
          // Match the spacer estimate and keep ten rows above the viewport.
          // Selecting only one earlier slice leaves a blank spacer at scrollTop=0.
          setAnchor(pinnedRef.current ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1,
            Math.floor(node.scrollTop / 72) + Math.floor(windowSize / 2) - 10)));
        }
        if (node.scrollTop < 48 && hasOlder && !olderError) {
          void loadOlder();
        }
      }}
    >
      {hasOlder && windowed.start === 0 ? (
        <button className="bot-thread-older" type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>
          {i18n.t(olderError ? 'projectAgent.chat.olderFailed' : loadingOlder ? 'projectAgent.chat.loadingOlder' : 'projectAgent.chat.loadOlder')}
        </button>
      ) : null}
      {rows.length === 0 ? (
        <div className="bot-thread-empty">
          <BotAvatar avatar={avatar} label={label} workspaceId={workspaceId} mood={avatarMood} />
          <p>{i18n.t('projectAgent.chat.empty')}</p>
        </div>
      ) : null}
      {windowed.start > 0 ? <div className="bot-thread-spacer" style={{ height: windowed.start * 72 }} /> : null}
      {windowed.rows.map((row) => (
        row.type === 'separator' ? (
          <p key={row.id} className="bot-separator">{separatorText(row, i18n)}</p>
        ) : row.message.kind === 'user_input' ? (
          <UserBubble
            key={row.message.id}
            message={row.message}
            replied={replied.has(row.message.id)}
            highlighted={highlightedId === row.message.id}
            i18n={i18n}
            onRetry={onRetry}
            onLocateSession={onLocateSession}
          />
        ) : row.message.kind === 'system_card' ? (
          <SystemCard
            key={row.message.id}
            workspaceId={workspaceId}
            message={row.message}
            highlighted={highlightedId === row.message.id}
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
            highlighted={highlightedId === row.message.id}
            i18n={i18n}
            onJump={onJump}
            onQuote={(excerpt) => onQuote(row.message.id, excerpt)}
            onLocateSession={onLocateSession}
            onOpenEvidence={onOpenEvidence}
            onOpenProcess={onOpenProcess ? () => onOpenProcess(row.message.id) : undefined}
          />
        )
      ))}
      {windowed.start + windowed.rows.length < rows.length ? (
        <div className="bot-thread-spacer" style={{ height: (rows.length - windowed.start - windowed.rows.length) * 72 }} />
      ) : null}
    </div>
  );
}

function SystemCard({
  workspaceId,
  message,
  highlighted,
  welcome,
  avatar,
  label,
  avatarMood,
  i18n,
}: {
  readonly workspaceId: string;
  readonly message: BotChatMessage;
  readonly highlighted: boolean;
  readonly welcome: boolean;
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
      <CardView workspaceId={workspaceId} cards={cards} i18n={i18n} />
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

function clip(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, 42).join('');
}
