import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { stripHistoricalLocalRecordForDisplay } from '../../chat/state/historicalLocalRecord';
import type { BotNarrationSegment } from '../state/botNarrationState';

/** The bot's public updates stay in the conversation after its conclusion arrives. */
export function BotNarration({ segments, live = false }: { readonly segments: readonly BotNarrationSegment[]; readonly live?: boolean }) {
  const cleanSegments = segments.flatMap((segment) => {
    const text = stripHistoricalLocalRecordForDisplay(segment.text);
    return text ? [{ ...segment, text }] : [];
  });
  if (!cleanSegments.length) return null;
  return <div className="bot-narration" data-live={live}>
    {cleanSegments.map(segment => <div className="bot-reply-body bot-narration-segment" data-narration-id={segment.id} key={segment.id} aria-live="off">
      <MarkdownMessage content={segment.text} />
    </div>)}
  </div>;
}
