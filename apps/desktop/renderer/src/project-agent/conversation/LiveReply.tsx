import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { ReplyAnchors } from './ReplyAnchors';
import { BotProcess, type ProcessDisclosure } from './BotProcess';

export function LiveReply({ activity, i18n, anchors, onJump, disclosure }: { readonly activity: ProjectAgentActivity; readonly i18n: I18nRuntime; readonly anchors: ReadonlyMap<string, string>; readonly onJump: (id: string) => void; readonly disclosure?: ProcessDisclosure }) {
  return (
    <article className="bot-reply bot-live-reply" data-turn-id={activity.turnId} data-phase={activity.phase} aria-label={i18n.t('projectAgent.chat.generating')}>
      <ReplyAnchors ids={activity.replyTo} anchors={anchors} i18n={i18n} onJump={onJump} />
      {activity.segments.map(segment => segment.kind === 'text' ? (
        <div aria-live="off" className="bot-reply-body" key={segment.id}><MarkdownMessage content={segment.text} /></div>
      ) : null)}
      <BotProcess activity={activity} i18n={i18n} disclosure={disclosure} />
      {activity.replyText ? <div aria-live="off" className="bot-reply-body"><MarkdownMessage content={activity.replyText} /></div> : null}
    </article>
  );
}
