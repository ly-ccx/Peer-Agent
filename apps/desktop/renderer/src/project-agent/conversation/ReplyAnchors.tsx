import type { I18nRuntime } from '@peer-agent/i18n';
import type { ReplyAnchor } from '../state/replyReferenceState';
import { PeerIcon } from '../../ui/icons';

export function ReplyAnchors({ ids, anchors, i18n, onJump }: {
  readonly ids: readonly string[];
  readonly anchors: ReadonlyMap<string, ReplyAnchor>;
  readonly i18n: I18nRuntime;
  readonly onJump: (id: string) => void;
}) {
  if (!ids.length) return null;
  return <div className="bot-reply-anchors">
    {ids.map(id => <ReplyAnchorPreview key={id} id={id} anchor={anchors.get(id)} i18n={i18n} onJump={onJump} />)}
  </div>;
}

export function ReplyAnchorPreview({ id, anchor, excerpt, className = '', i18n, onJump }: {
  readonly id: string;
  readonly anchor?: ReplyAnchor;
  readonly excerpt?: string;
  readonly className?: string;
  readonly i18n: I18nRuntime;
  readonly onJump: (id: string) => void;
}) {
  const source = anchor?.author || i18n.t('projectAgent.chat.quote');
  const text = excerpt || anchor?.excerpt || i18n.t('projectAgent.chat.originalMessage');
  const description = `${i18n.t('projectAgent.chat.originalMessage')}: ${source} · ${text}`;
  const date = anchor?.createdAt ? new Date(anchor.createdAt) : null;
  const time = date && Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(i18n.locale, { hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <button type="button" className={`bot-reply-bar bot-reply-source ${className}`.trim()} title={description} aria-label={description} onClick={() => onJump(id)}>
      <span className="bot-reply-bar-copy">
        <span className="bot-reply-bar-header">
          <span className="bot-reply-bar-source">
            <span className="bot-reply-bar-label">{source}</span>
            {time ? <><span aria-hidden="true">·</span><time dateTime={anchor?.createdAt}>{time}</time></> : null}
          </span>
          <span className="bot-reply-bar-action"><PeerIcon name="arrowUpRight" size={14} />{i18n.t('projectAgent.chat.viewOriginal')}</span>
        </span>
        <span className="bot-reply-bar-excerpt">{text}</span>
      </span>
    </button>
  );
}
