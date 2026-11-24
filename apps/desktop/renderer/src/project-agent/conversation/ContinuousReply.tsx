import { ReplyResourceContext } from './ReplyResourceContext';
import { referencesForReplyParagraph } from '../state/botResourceReference';
import { useRef } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { stripHistoricalLocalRecordForDisplay } from '../../chat/state/historicalLocalRecord';
import type { BotReplyRow } from '../state/botReplyContinuity';
import { isActivityRunning } from '../state/botActivityState';
import { BotSelectionQuote } from './BotSelectionQuote';
import { CardView } from './CardView';
import { ReplyAnchors } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { ReplyPresence } from './ReplyPresence';
import { ReplyTaskReferences } from './ReplyTaskReferences';
import type { BotWorkIndex } from '../state/botWorkState';

/** One DOM carrier from receipt to delivery, including yields, recovery and terminal cards. */
export function ContinuousReply({ workspaceId, reply, referenceIds, anchors, highlighted, i18n, onJump, onQuote, onReload, onOpenDetails, workIndex, onOpenWork }: {
  readonly workspaceId: string; readonly reply: BotReplyRow; readonly referenceIds: readonly string[];
  readonly anchors: ReadonlyMap<string, ReplyAnchor>; readonly highlighted: boolean; readonly i18n: I18nRuntime;
  readonly onJump: (id: string) => void; readonly onQuote: (id: string, excerpt: string) => void;
  readonly onReload: () => void; readonly onOpenDetails?: (id: string) => void;
  readonly workIndex: BotWorkIndex; readonly onOpenWork: (sessionId: string) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const message = reply.message;
  const running = isActivityRunning(reply.activity ?? null);
  const isAgentReply = message?.kind === 'agent_reply';
  const cleanMessageContent = isAgentReply ? stripHistoricalLocalRecordForDisplay(message.content) : '';
  const cleanParagraphs = reply.paragraphs.flatMap((paragraph, index) => {
    const clean = stripHistoricalLocalRecordForDisplay(paragraph.text);
    if (clean) return [{ ...paragraph, text: clean }];
    if (
      isAgentReply
      && !running
      && index === reply.paragraphs.length - 1
      && paragraph.text.trim().length > 0
      && !cleanMessageContent
    ) {
      return [{ ...paragraph, text: i18n.t('projectAgent.chat.protocolLeakFallback') }];
    }
    return [];
  });
  const detailsId = running ? reply.activity?.turnId : message?.id ?? reply.activity?.turnId ?? reply.aliases.at(-1);
  const openDetails = detailsId && onOpenDetails ? () => onOpenDetails(detailsId) : undefined;
  const cards = running ? [] : message?.cards.map(card => card.kind === 'agent_stopped'
    && cleanParagraphs.at(-1)?.text.trim() === card.content.trim() ? { ...card, content: '' } : card) ?? [];
  return <article className={`bot-reply bot-continuous-reply${reply.activity ? ' bot-live-reply' : ''}${highlighted ? ' is-anchored' : ''}`}
    id={message ? `bot-msg-${message.id}` : undefined} data-kind={message?.kind ?? 'reply_pending'}
    data-turn-id={reply.activity?.turnId ?? message?.turnId} data-phase={reply.activity?.phase}>
    {reply.aliases.filter(id => id !== message?.id).map(id => <span key={id} id={`bot-msg-${id}`} className="bot-reply-alias" tabIndex={-1} />)}
    <div className="bot-narration bot-continuous-paragraphs" data-live={running}>
    {cleanParagraphs.map((paragraph, index) => <div key={paragraph.id} className="bot-reply-body bot-narration-segment" aria-live="off" data-narration-id={paragraph.id}>
      {index === 0 ? <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} /> : null}
      <div className="bot-reply-text" ref={isAgentReply && index === cleanParagraphs.length - 1 ? body : undefined}>
        <ReplyResourceContext references={referencesForReplyParagraph(paragraph.id, reply.messages, reply.activity)}>
          <MarkdownMessage content={paragraph.text} />
        </ReplyResourceContext>
      </div>
    </div>)}
    </div>
    <ReplyTaskReferences messages={reply.messages} workIndex={workIndex} i18n={i18n} onOpen={onOpenWork} />
    <CardView workspaceId={workspaceId} cards={cards} i18n={i18n} workIndex={workIndex} onOpenWork={onOpenWork} />
    {isAgentReply && cleanMessageContent.trim() ? <BotSelectionQuote root={body} label={i18n.t('projectAgent.chat.quote')} onQuote={excerpt => onQuote(message.id, excerpt)} /> : null}
    <ReplyPresence reply={reply} i18n={i18n} onReload={onReload} onOpenDetails={openDetails}
      onQuote={isAgentReply && cleanMessageContent.trim() ? () => onQuote(message.id, cleanMessageContent) : undefined} />
  </article>;
}
