import type { BotListItem } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import { BotAvatar } from './BotAvatar';
import { PeerIcon } from '../ui/icons';
import { botAvatarMood, type BotAvatarMood } from './state/botAvatarState';

interface BotRowProps {
  readonly item: BotListItem;
  readonly avatarMood?: BotAvatarMood;
  readonly highlighted: boolean;
  readonly opened: boolean;
  readonly timeLabel: string;
  readonly i18n: I18nRuntime;
  readonly onHighlight: (workspaceId: string) => void;
  readonly onAttention?: (workspaceId: string) => void;
  readonly onOpen: (workspaceId: string) => void;
}

export function BotRow({ item, avatarMood, highlighted, opened, timeLabel, i18n, onHighlight, onOpen, onAttention }: BotRowProps) {
  const name = item.profile.displayName;
  const preview = item.preview.trim() || i18n.t('projectAgent.list.noPreview');
  const needsYou = item.state.needsYou;
  return (
    <div
      id={`bot-row-${item.workspaceId}`}
      className={`bot-row${highlighted ? ' is-highlighted' : ''}${opened ? ' is-open' : ''}`}
      role="option"
      aria-selected={highlighted}
      tabIndex={-1}
      onMouseEnter={() => onHighlight(item.workspaceId)}
      onClick={() => onOpen(item.workspaceId)}

    >
      <BotAvatar avatar={item.profile.avatar} label={name} workspaceId={item.workspaceId} animate mood={avatarMood ?? botAvatarMood(item.state)} />
      <span className="bot-row-copy">
        <span className="bot-row-name">{name}</span>
        <span className="bot-row-preview">{preview}</span>
      </span>
      <span className="bot-row-side">
        {timeLabel ? <span className="bot-row-time">{timeLabel}</span> : <span className="bot-row-time" />}
        {needsYou > 0 ? (
          <button type="button" className="bot-badge" aria-label={i18n.t('projectAgent.list.needsYouBadge', { count: needsYou })}
            onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
            onClick={event => { event.stopPropagation(); onAttention?.(item.workspaceId); }}>
            {needsYou}
            <span className="bot-sr">{i18n.t('projectAgent.list.needsYouBadge', { count: needsYou })}</span>
          </button>
        ) : item.state.unread > 0 ? (
          <span className="bot-unread">
            <span className="bot-sr">{i18n.t('projectAgent.list.unread')}</span>
          </span>
        ) : item.state.running > 0 ? (
          <span>
            <PeerIcon name="loader" size={10} className="bot-spin motion-spin" />
            <span className="bot-sr">{i18n.t('projectAgent.list.running')}</span>
          </span>
        ) : null}
      </span>
    </div>
  );
}
