import type { I18nRuntime } from '@peer-agent/i18n';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { MarkdownMessage } from '../../chat/components/markdown/MarkdownMessage';
import { PeerIcon } from '../../ui/icons';
import { ReplyAnchors } from './ReplyAnchors';
import { toolPresentation } from '../drawer/agentProcess';

export function LiveReply({ activity, i18n, anchors, onJump }: { readonly activity: ProjectAgentActivity; readonly i18n: I18nRuntime; readonly anchors: ReadonlyMap<string, string>; readonly onJump: (id: string) => void }) {
  const hasText = activity.replyText || activity.segments.some(segment => segment.kind === 'text' && segment.text);
  const activeTool = activity.segments.some(segment => segment.kind === 'tool' && segment.status === 'running');
  return (
    <article className="bot-reply bot-live-reply" data-turn-id={activity.turnId} data-phase={activity.phase} aria-label={i18n.t('projectAgent.chat.generating')}>
      <ReplyAnchors ids={activity.replyTo} anchors={anchors} i18n={i18n} onJump={onJump} />
      {activity.segments.map(segment => segment.kind === 'text' ? (
        <div aria-live="off" className="bot-reply-body" key={segment.id}><MarkdownMessage content={segment.text} /></div>
      ) : (
        <div className="bot-live-tool" data-status={segment.status} key={segment.id}>
          <PeerIcon name={toolPresentation(segment.name).icon} size={14} />
          <span>{i18n.t(segment.status === 'running' ? 'projectAgent.chat.toolRunning' : segment.status === 'error' ? 'projectAgent.chat.toolFailed' : 'projectAgent.chat.toolDone', { tool: i18n.t(toolPresentation(segment.name).labelKey) })}</span>
        </div>
      ))}
      {activity.replyText ? <div aria-live="off" className="bot-reply-body"><MarkdownMessage content={activity.replyText} /></div> : null}
      {!hasText && !activeTool ? <p className="bot-live-status" role="status">{i18n.t(activity.phase === 'waiting' ? 'projectAgent.chat.waiting' : 'projectAgent.chat.thinking')}</p> : null}
      {hasText && !activeTool ? <span className="bot-live-indicator" aria-hidden="true" /> : null}
    </article>
  );
}
