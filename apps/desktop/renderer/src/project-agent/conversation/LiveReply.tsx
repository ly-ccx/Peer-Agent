import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { ReplyAnchors } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { BotNarration } from './BotNarration';
import { botNarration } from '../state/botNarrationState';
import { ReplyContext } from './ReplyContext';
import { isActivityRunning } from '../state/botActivityState';

export function LiveReply({ activity, referenceIds, i18n, anchors, onJump, onOpenDetails }: {
  readonly activity: ProjectAgentActivity; readonly referenceIds: readonly string[];
  readonly i18n: I18nRuntime; readonly anchors: ReadonlyMap<string, ReplyAnchor>;
  readonly onJump: (id: string) => void; readonly onOpenDetails?: () => void;
}) {
  return (
    <article className="bot-reply bot-live-reply" data-turn-id={activity.turnId} data-phase={activity.phase} aria-label={i18n.t('projectAgent.chat.generating')}>
      {!activity.replyText ? <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} /> : null}
      <BotNarration segments={botNarration(activity.segments.flatMap(segment => segment.kind === 'text' ? [segment] : []), activity.replyText)} live />
      {activity.replyText ? <div aria-live="off" className="bot-reply-body bot-streaming-conclusion">
        <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} />
        <MarkdownMessage content={activity.replyText} />
      </div> : null}
      <ReplyContext i18n={i18n} onOpenDetails={onOpenDetails} running={isActivityRunning(activity)} />
    </article>
  );
}
