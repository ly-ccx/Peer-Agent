import { useRef } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import type { BotReplyRow } from '../state/botReplyContinuity';
import { isActivityRunning } from '../state/botActivityState';
import { BotSelectionQuote } from './BotSelectionQuote';
import { CardView } from './CardView';
import { ReplyAnchors } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { ReplyPresence } from './ReplyPresence';

/** One DOM carrier from receipt to delivery, including yields, recovery and terminal cards. */
export function ContinuousReply({ workspaceId, reply, referenceIds, anchors, highlighted, i18n, onJump, onQuote, onReload, onOpenDetails }: {
  readonly workspaceId: string; readonly reply: BotReplyRow; readonly referenceIds: readonly string[];
  readonly anchors: ReadonlyMap<string, ReplyAnchor>; readonly highlighted: boolean; readonly i18n: I18nRuntime;
  readonly onJump: (id: string) => void; readonly onQuote: (id: string, excerpt: string) => void;
  readonly onReload: () => void; readonly onOpenDetails?: (id: string) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const message = reply.message;
  const running = isActivityRunning(reply.activity ?? null);
  const detailsId = running ? reply.activity?.turnId : message?.id ?? reply.activity?.turnId ?? reply.aliases.at(-1);
  const openDetails = detailsId && onOpenDetails ? () => onOpenDetails(detailsId) : undefined;
  const cards = running ? [] : message?.cards.map(card => card.kind === 'agent_stopped'
    && reply.paragraphs.at(-1)?.text.trim() === card.content.trim() ? { ...card, content: '' } : card) ?? [];
  return <article className={`bot-reply bot-continuous-reply${reply.activity ? ' bot-live-reply' : ''}${highlighted ? ' is-anchored' : ''}`}
    id={message ? `bot-msg-${message.id}` : undefined} data-kind={message?.kind ?? 'reply_pending'}
    data-turn-id={reply.activity?.turnId ?? message?.turnId} data-phase={reply.activity?.phase}>
    {reply.aliases.filter(id => id !== message?.id).map(id => <span key={id} id={`bot-msg-${id}`} className="bot-reply-alias" tabIndex={-1} />)}
    {reply.paragraphs.length ? <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} /> : null}
    <div className="bot-narration bot-continuous-paragraphs" data-live={running}>
    {reply.paragraphs.map((paragraph, index) => <div key={paragraph.id} className="bot-reply-body bot-narration-segment" aria-live="off" data-narration-id={paragraph.id}>
      <div className="bot-reply-text" ref={message?.kind === 'agent_reply' && index === reply.paragraphs.length - 1 ? body : undefined}>
        <MarkdownMessage content={paragraph.text} />
      </div>
    </div>)}
    </div>
    <CardView workspaceId={workspaceId} cards={cards} i18n={i18n} />
    {message?.kind === 'agent_reply' ? <BotSelectionQuote root={body} label={i18n.t('projectAgent.chat.quote')} onQuote={excerpt => onQuote(message.id, excerpt)} /> : null}
    <ReplyPresence reply={reply} i18n={i18n} onReload={onReload} onOpenDetails={openDetails} />
  </article>;
}
