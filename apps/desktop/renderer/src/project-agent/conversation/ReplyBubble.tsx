import { ReplyResourceContext } from './ReplyResourceContext';
import type { I18nRuntime } from '@peer-agent/i18n';
import { useRef } from 'react';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { stripHistoricalLocalRecordForDisplay } from '../../chat/state/historicalLocalRecord';
import { BotSelectionQuote } from './BotSelectionQuote';
import type { BotChatMessage } from '../state/botConversationState';
import { ReplyContext } from './ReplyContext';
import { CardView } from './CardView';
import { ReplyAnchors } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { BotNarration } from './BotNarration';
import type { BotNarrationSegment } from '../state/botNarrationState';
import { ReplyTaskReferences } from './ReplyTaskReferences';
import { InlineInteractiveReplies } from './InlineInteractiveReplies';
import type { BotWorkIndex } from '../state/botWorkState';

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
  workIndex,
  onOpenWork,
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
  readonly workIndex: BotWorkIndex;
  readonly onOpenWork: (sessionId: string) => void;
  readonly narration?: readonly BotNarrationSegment[];
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const cleanContent = stripHistoricalLocalRecordForDisplay(message.content);
  const displayContent = !cleanContent && message.content.trim().length > 0
    ? i18n.t('projectAgent.chat.protocolLeakFallback')
    : cleanContent;
  const cleanNarration = narration.flatMap((segment) => {
    const text = stripHistoricalLocalRecordForDisplay(segment.text);
    return text ? [{ ...segment, text }] : [];
  });
  return (
    <article
      className={`bot-reply${highlighted ? ' is-anchored' : ''}`}
      id={`bot-msg-${message.id}`}
      data-kind="agent_reply"
    >
      <ReplyResourceContext references={message.resourceReferences}><BotNarration segments={cleanNarration} /></ReplyResourceContext>
      <div className="bot-reply-body">
        <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} />
        <div ref={bodyRef} className="bot-reply-text">
          <ReplyResourceContext references={message.resourceReferences}><MarkdownMessage content={displayContent} /></ReplyResourceContext>
        </div>
      </div>
      <InlineInteractiveReplies workspaceId={workspaceId} evidenceRefs={message.meta?.evidenceRefs ?? []} isZh={Boolean(i18n.locale?.startsWith('zh'))} />
      <ReplyTaskReferences messages={[message]} workIndex={workIndex} i18n={i18n} onOpen={onOpenWork} />
      <CardView workspaceId={workspaceId} cards={message.cards} i18n={i18n} workIndex={workIndex} onOpenWork={onOpenWork} />
      <BotSelectionQuote root={bodyRef} label={i18n.t('projectAgent.chat.quote')} onQuote={onQuote} />
      <ReplyContext i18n={i18n} onOpenDetails={onOpenDetails}
        onQuote={cleanContent.trim() ? () => onQuote(cleanContent) : undefined} />
    </article>
  );
}
