import type { I18nRuntime } from '@peer-agent/i18n';
import { useRef, useState } from 'react';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import type { BotChatMessage } from '../state/botConversationState';
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
}: {
  readonly workspaceId: string;
  readonly message: BotChatMessage;
  readonly anchors: ReadonlyMap<string, string>;
  readonly highlighted: boolean;
  readonly i18n: I18nRuntime;
  readonly onJump: (messageId: string) => void;
  readonly onQuote: (excerpt: string) => void;
  readonly onLocateSession: (sessionId: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [excerpt, setExcerpt] = useState('');
  const used = message.meta.memoryUsed?.length ?? 0;
  const learned = message.meta.memoryLearned?.length ?? 0;
  const surfacing = message.meta.surfacing;
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
          onClick={() => onJump(anchorId)}
        >
          <span>{i18n.t('projectAgent.chat.replyTo')}</span>
          <span>{anchors.get(anchorId) || anchorId}</span>
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
      {excerpt ? (
        <button type="button" className="bot-quote-action" onClick={() => onQuote(excerpt)}>
          {i18n.t('projectAgent.chat.quote')}
        </button>
      ) : null}
      <div className="bot-reply-marks">
        {sourceIds.map((sessionId) => (
          <button key={sessionId} type="button" onClick={() => onLocateSession(sessionId)}>
            {i18n.t('projectAgent.chat.source')}
          </button>
        ))}
        {message.marks.map((mark) => {
          const key = mark.outcome && mark.outcome in VERDICT_KEYS
            ? VERDICT_KEYS[mark.outcome as keyof typeof VERDICT_KEYS]
            : null;
          if (!key) return null;
          return <span key={`${mark.sessionId ?? ''}-${mark.outcome}`}>{i18n.t(key)}</span>;
        })}
        {used > 0 ? <span>{i18n.t('projectAgent.chat.memoryUsed', { count: used })}</span> : null}
        {learned > 0 ? <span>{i18n.t('projectAgent.chat.memoryLearned', { count: learned })}</span> : null}
        {surfacing && surfacing in SURFACING_KEYS ? (
          <span>{i18n.t(SURFACING_KEYS[surfacing as keyof typeof SURFACING_KEYS])}</span>
        ) : null}
      </div>
      <CardView workspaceId={workspaceId} cards={message.cards} i18n={i18n} />
    </article>
  );
}
