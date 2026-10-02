import type { I18nRuntime } from '@peer-agent/i18n';
import { useRef, useState } from 'react';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { clientApi } from '../../clientApi';
import { PeerIcon } from '../../ui/icons';
import type { BotChatMessage } from '../state/botConversationState';
import { readMemoryRecords, type MemoryRecord } from '../state/drawerState';
import { CardView } from './CardView';

const VERDICT_KEYS = {
  passed: 'projectAgent.chat.verdict.passed',
  failed: 'projectAgent.chat.verdict.failed',
  partial: 'projectAgent.chat.verdict.partial',
  unverifiable: 'projectAgent.chat.verdict.unverifiable',
} as const;

const SURFACING_KEYS = {
  interrupt: 'projectAgent.chat.surfacing.interrupt',
  message: 'projectAgent.chat.surfacing.message',
  digest: 'projectAgent.chat.surfacing.digest',
  silent: 'projectAgent.chat.surfacing.silent',
} as const;

export function ReplyBubble({
  workspaceId,
  message,
  anchors,
  highlighted,
  i18n,
  onJump,
  onQuote,
  onLocateSession,
  onOpenEvidence,
  onOpenProcess,
}: {
  readonly workspaceId: string;
  readonly message: BotChatMessage;
  readonly anchors: ReadonlyMap<string, string>;
  readonly highlighted: boolean;
  readonly i18n: I18nRuntime;
  readonly onJump: (messageId: string) => void;
  readonly onQuote: (excerpt: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
  readonly onOpenEvidence?: (evidenceRef: string) => void;
  readonly onOpenProcess?: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [excerpt, setExcerpt] = useState('');
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const used = message.meta.memoryUsed ?? [];
  const learned = message.meta.memoryLearned ?? [];
  const surfacing = message.meta.surfacing;
  const evidenceRefs = message.meta.evidenceRefs ?? [];
  const sourceIds = [...new Set([
    ...message.sources,
    ...message.marks.map((mark) => mark.sessionId).filter((id): id is string => Boolean(id)),
  ])];

  return (
    <article
      className={`bot-reply${highlighted ? ' is-anchored' : ''}`}
      id={`bot-msg-${message.id}`}
      data-kind="agent_reply"
    >
      {message.replyTo.map((anchorId) => (
        <button
          key={anchorId}
          type="button"
          className="bot-reply-bar"
          title={anchors.get(anchorId) || anchorId}
          onClick={() => onJump(anchorId)}
        >
          <PeerIcon name="back" size={15} />
          <span className="bot-reply-bar-copy">
            <span className="bot-reply-bar-label">{i18n.t('projectAgent.chat.replyTo')}</span>
            <span className="bot-reply-bar-excerpt">{anchors.get(anchorId) || anchorId}</span>
          </span>
          <PeerIcon name="chevronRight" size={14} />
        </button>
      ))}
      <div
        className="bot-reply-body"
        ref={bodyRef}
        onMouseUp={() => {
          const selection = window.getSelection();
          const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
          const node = bodyRef.current;
          const inside = Boolean(node && selection?.anchorNode && node.contains(selection.anchorNode));
          setExcerpt(inside ? text : '');
        }}
      >
        <MarkdownMessage content={message.content} />
      </div>
      <div className="bot-reply-marks">
        {excerpt ? (
          <button type="button" className="bot-quote-action" onClick={() => onQuote(excerpt)}>
            <PeerIcon name="back" size={14} />
            {i18n.t('projectAgent.chat.quote')}
          </button>
        ) : null}
        {(showAllEvidence ? evidenceRefs : evidenceRefs.slice(0, 3)).map((evidenceRef, index) => (
          <button key={evidenceRef} type="button" onClick={() => onOpenEvidence?.(evidenceRef)}>
            <PeerIcon name="fileText" size={13} />
            {i18n.t('projectAgent.chat.evidence')} {index + 1}
          </button>
        ))}
        {evidenceRefs.length > 3 ? (
          <button type="button" aria-expanded={showAllEvidence} onClick={() => setShowAllEvidence(!showAllEvidence)}>
            <PeerIcon name={showAllEvidence ? 'chevronUp' : 'chevronDown'} size={13} />
            {i18n.t(showAllEvidence ? 'projectAgent.chat.evidenceCollapse' : 'projectAgent.chat.evidenceMore', { count: evidenceRefs.length - 3 })}
          </button>
        ) : null}
        {onOpenProcess ? (
          <button type="button" onClick={onOpenProcess}>
            <PeerIcon name="terminal" size={14} />
            {i18n.t('projectAgent.chat.openProcess')}
          </button>
        ) : null}
        {sourceIds.map((sessionId) => {
          const state = message.meta.sessionStates?.find(state => state.sessionId === sessionId);
          return <button key={sessionId} type="button" onClick={() => onLocateSession(sessionId)}>
            <PeerIcon name="arrowUpRight" size={14} />
            {state ? i18n.t(`projectAgent.chat.sessionState.${state.status}`) : i18n.t('projectAgent.chat.source')}
          </button>;
        })}
        {message.marks.map((mark) => {
          const key = mark.outcome && mark.outcome in VERDICT_KEYS
            ? VERDICT_KEYS[mark.outcome as keyof typeof VERDICT_KEYS]
            : null;
          if (!key) return null;
          return <span className="bot-reply-status" key={`${mark.sessionId ?? ''}-${mark.outcome}`}>{i18n.t(key)}</span>;
        })}
        <MemoryChip
          workspaceId={workspaceId}
          ids={used}
          label={i18n.t('projectAgent.chat.memoryUsed', { count: used.length })}
        />
        <MemoryChip
          workspaceId={workspaceId}
          ids={learned}
          label={i18n.t('projectAgent.chat.memoryLearned', { count: learned.length })}
        />
        {surfacing && surfacing in SURFACING_KEYS ? (
          <span className="bot-reply-delivery">
            <PeerIcon name="info" size={13} />
            {i18n.t('projectAgent.chat.surfacingLabel')}{i18n.t(SURFACING_KEYS[surfacing as keyof typeof SURFACING_KEYS])}
          </span>
        ) : null}
      </div>
      <CardView workspaceId={workspaceId} cards={message.cards} i18n={i18n} />
    </article>
  );
}

function MemoryChip({
  workspaceId,
  ids,
  label,
}: {
  readonly workspaceId: string;
  readonly ids: readonly string[];
  readonly label: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<readonly MemoryRecord[]>([]);
  if (ids.length === 0) return null;
  return (
    <div className="bot-memory-chip">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          void clientApi.projectMemoryList({ workspaceId, ids }).then((result) => {
            const records = readMemoryRecords(result?.items);
            const byId = new Map(records.map((item) => [item.id, item]));
            setRows(ids.map((id) => byId.get(id) ?? {
              id,
              kind: 'fact',
              text: id,
              trust: 'stated',
              status: 'active',
              pinned: false,
            }));
            setOpen(true);
          });
        }}
      >
        <PeerIcon name="fileText" size={13} />
        {label}
        <PeerIcon name={open ? 'chevronUp' : 'chevronDown'} size={12} />
      </button>
      {open ? (
        <ul>
          {rows.map((row) => <li key={row.id}>{row.text}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
