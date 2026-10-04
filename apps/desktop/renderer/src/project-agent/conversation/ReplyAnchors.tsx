import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../../ui/icons';

export function ReplyAnchors({ ids, anchors, i18n, onJump }: {
  readonly ids: readonly string[];
  readonly anchors: ReadonlyMap<string, string>;
  readonly i18n: I18nRuntime;
  readonly onJump: (id: string) => void;
}) {
  return ids.map(id => (
    <button key={id} type="button" className="bot-reply-bar" title={anchors.get(id) || id} onClick={() => onJump(id)}>
      <span className="bot-reply-bar-copy">
        <span className="bot-reply-bar-label">{i18n.t('projectAgent.chat.replyTo')}</span>
        <span className="bot-reply-bar-excerpt">{anchors.get(id) || id}</span>
      </span>
      <PeerIcon name="chevronRight" size={14} />
    </button>
  ));
}
