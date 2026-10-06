import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { DelegatedWork } from './DelegatedWork';
import type { BotWorkRow } from '../state/botWorkState';
import { ReplyAnchors } from './ReplyAnchors';
import { BotProcess, type ProcessDisclosure } from './BotProcess';
import type { ReplyAnchor } from '../state/replyReferenceState';

export function LiveReply({ activity, referenceIds, i18n, anchors, onJump, disclosure, workRows, onOpenWork }: { readonly activity: ProjectAgentActivity; readonly referenceIds: readonly string[]; readonly i18n: I18nRuntime; readonly anchors: ReadonlyMap<string, ReplyAnchor>; readonly onJump: (id: string) => void; readonly disclosure?: ProcessDisclosure; readonly workRows: readonly BotWorkRow[]; readonly onOpenWork: (id: string) => void }) {
  return (
    <article className="bot-reply bot-live-reply" data-turn-id={activity.turnId} data-phase={activity.phase} aria-label={i18n.t('projectAgent.chat.generating')}>
      <ReplyAnchors ids={referenceIds} anchors={anchors} i18n={i18n} onJump={onJump} />
      {activity.segments.map(segment => segment.kind === 'text' ? (
        <div aria-live="off" className="bot-reply-body" key={segment.id}><MarkdownMessage content={segment.text} /></div>
      ) : null)}
      <BotProcess activity={activity} i18n={i18n} disclosure={disclosure} />
      {activity.replyText ? <div aria-live="off" className="bot-reply-body"><MarkdownMessage content={activity.replyText} /></div> : null}
      <DelegatedWork rows={workRows} i18n={i18n} onOpen={onOpenWork} disclosure={disclosure} />
    </article>
  );
}
