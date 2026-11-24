import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotAvatar as BotAvatarModel, ProjectAgentActivity } from '@peer-agent/protocol';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { stripHistoricalLocalRecordForDisplay } from '../../chat/state/historicalLocalRecord';
import { ReplyAnchors } from './ReplyAnchors';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { BotNarration } from './BotNarration';
import { botNarration } from '../state/botNarrationState';
import { ReplyContext } from './ReplyContext';

export function LiveReply({ activity, referenceIds, i18n, anchors, onJump, onOpenDetails, avatar, workspaceId, botLabel }: {
  readonly activity: ProjectAgentActivity; readonly referenceIds: readonly string[];
  readonly i18n: I18nRuntime; readonly anchors: ReadonlyMap<string, ReplyAnchor>;
  readonly onJump: (id: string) => void; readonly onOpenDetails?: () => void;
  readonly avatar: BotAvatarModel; readonly workspaceId: string; readonly botLabel: string;
}) {
  const cleanReplyText = activity.replyText ? stripHistoricalLocalRecordForDisplay(activity.replyText) : '';
  const cleanSegments = (activity.segments ?? []).flatMap((segment) => {
    if (segment.kind !== 'text') return [];
    const text = stripHistoricalLocalRecordForDisplay(segment.text);
    return text ? [{ ...segment, text }] : [];
  });
  return (
    <article className="bot-reply bot-live-reply" data-turn-id={activity.turnId} data-phase={activity.phase} aria-label={i18n.t('projectAgent.chat.generating')}>
      {!cleanReplyText ? <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} /> : null}
      <BotNarration segments={botNarration(cleanSegments, cleanReplyText)} live />
      {cleanReplyText ? <div aria-live="off" className="bot-reply-body bot-streaming-conclusion">
        <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} />
        <MarkdownMessage content={cleanReplyText} />
      </div> : null}
      <ReplyContext i18n={i18n} onOpenDetails={onOpenDetails} activity={activity} avatar={avatar} workspaceId={workspaceId} botLabel={botLabel} />
    </article>
  );
}
