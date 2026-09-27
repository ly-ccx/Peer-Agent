import type { I18nRuntime } from '@peer-agent/i18n';
import { useEffect, useRef, useState } from 'react';
import {
  formatConversationStamp,
  repliedUserIds,
  windowConversationRows,
  type BotChatMessage,
  type ConversationRow,
} from '../state/botConversationState';
import { CardView } from './CardView';
import { ReplyBubble } from './ReplyBubble';
import { UserBubble } from './UserBubble';

export function BotMessageList({
  workspaceId,
  rows,
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
  readonly rows: readonly ConversationRow[];
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
  const [anchor, setAnchor] = useState(Math.max(0, rows.length - 1));
  const messages = rows.flatMap((row) => (row.type === 'message' ? [row.message] : []));
  const anchors = new Map(messages.map((message) => [message.id, clip(message.content)]));
  const replied = repliedUserIds(messages);
  const windowed = windowConversationRows(rows, anchor);

  useEffect(() => {
    if (pinnedRef.current) setAnchor(Math.max(0, rows.length - 1));
  }, [rows.length]);

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
      onScroll={(event) => {
        const node = event.currentTarget;
        pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        if (node.scrollTop < 48 && windowed.start > 0) {
          setAnchor((current) => Math.max(0, current - 40));
        }
      }}
    >
      {rows.length === 0 ? <p className="bot-thread-empty">{i18n.t('projectAgent.chat.empty')}</p> : null}
      {windowed.start > 0 ? <div className="bot-thread-spacer" style={{ height: windowed.start * 72 }} /> : null}
      {windowed.rows.map((row) => (
        row.type === 'separator' ? (
          <p key={row.id} className="bot-separator">{separatorText(row, i18n)}</p>
        ) : row.message.kind === 'user_input' ? (
          <UserBubble
            key={row.message.id}
            message={row.message}
            replied={replied.has(row.message.id)}
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
  i18n,
}: {
  readonly workspaceId: string;
  readonly message: BotChatMessage;
  readonly highlighted: boolean;
  readonly i18n: I18nRuntime;
}) {
  const cards = message.cards.length > 0
    ? message.cards
    : [{ cardId: message.id, kind: 'system_card', content: message.content, actions: [] }];
  return (
    <div className={`bot-system${highlighted ? ' is-anchored' : ''}`} id={`bot-msg-${message.id}`}>
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
