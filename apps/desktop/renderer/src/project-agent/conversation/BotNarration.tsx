import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import type { BotNarrationSegment } from '../state/botNarrationState';

/** The bot's public updates stay in the conversation after its conclusion arrives. */
export function BotNarration({ segments, live = false }: { readonly segments: readonly BotNarrationSegment[]; readonly live?: boolean }) {
  if (!segments.length) return null;
  return <div className="bot-narration" data-live={live}>
    {segments.map(segment => <div className="bot-reply-body bot-narration-segment" data-narration-id={segment.id} key={segment.id} aria-live="off">
      <MarkdownMessage content={segment.text} />
    </div>)}
  </div>;
}
