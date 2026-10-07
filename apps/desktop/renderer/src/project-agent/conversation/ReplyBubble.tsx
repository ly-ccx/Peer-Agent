import type { I18nRuntime } from '@peer-agent/i18n';
import { useRef } from 'react';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { BotSelectionQuote } from './BotSelectionQuote';
import type { BotChatMessage } from '../state/botConversationState';
import { ReplyContext } from './ReplyContext';
import { CardView } from './CardView';
import { ReplyAnchors } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { BotNarration } from './BotNarration';
import type { BotNarrationSegment } from '../state/botNarrationState';

export function ReplyBubble({
  workspaceId,
  message,
  referenceIds,
  anchors,
  highlighted,
  i18n,
  onJump,
  onQuote,
  onOpenDetails,
  narration = [],
}: {
  readonly workspaceId: string;
  readonly message: BotChatMessage;
  readonly referenceIds: readonly string[];
  readonly anchors: ReadonlyMap<string, ReplyAnchor>;
  readonly highlighted: boolean;
  readonly i18n: I18nRuntime;
  readonly onJump: (messageId: string) => void;
  readonly onQuote: (excerpt: string) => void;
  readonly onOpenDetails?: () => void;
  readonly narration?: readonly BotNarrationSegment[];
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <article
      className={`bot-reply${highlighted ? ' is-anchored' : ''}`}
      id={`bot-msg-${message.id}`}
      data-kind="agent_reply"
    >
      <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} />
      <BotNarration segments={narration} />
      <div
        className="bot-reply-body"
        ref={bodyRef}
      >
        <MarkdownMessage content={message.content} />
      </div>
      <CardView workspaceId={workspaceId} cards={message.cards} i18n={i18n} />
      <BotSelectionQuote root={bodyRef} label={i18n.t('projectAgent.chat.quote')} onQuote={onQuote} />
      <ReplyContext i18n={i18n} onOpenDetails={onOpenDetails} />
    </article>
  );
}
