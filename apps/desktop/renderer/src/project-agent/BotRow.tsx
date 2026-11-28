import { memo } from 'react';
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
  readonly hasTasks?: boolean;
  readonly expanded?: boolean;
  readonly timeLabel: string;
  readonly i18n: I18nRuntime;
  readonly onAttention?: (workspaceId: string) => void;
  readonly onOpen: (workspaceId: string) => void;
  readonly onToggleExpand?: (workspaceId: string) => void;
}

export const BotRow = memo(function BotRow({
  item,
  avatarMood,
  highlighted,
  opened,
  hasTasks = false,
  expanded = false,
  timeLabel,
  i18n,
  onOpen,
  onAttention,
  onToggleExpand,
}: BotRowProps) {
  const name = item.profile.displayName;
  const activeCount = item.state.running;
  const isZh = i18n.locale.startsWith('zh');
  const preview = activeCount > 0
    ? (isZh ? `${activeCount} 个工作中` : `${activeCount} working`)
    : item.preview.trim() || i18n.t('projectAgent.list.noPreview');
  const needsYou = item.state.needsYou;
  return (
    <div
      id={`bot-row-${item.workspaceId}`}
      className={`bot-row${highlighted ? ' is-highlighted' : ''}${opened ? ' is-open' : ''}`}
      role="option"
      aria-selected={highlighted}
      aria-expanded={hasTasks ? expanded : undefined}
      tabIndex={-1}
      onClick={() => onOpen(item.workspaceId)}
    >
      <span className="bot-row-avatar-wrap">
        <BotAvatar avatar={item.profile.avatar} label={name} workspaceId={item.workspaceId} animate mood={avatarMood ?? botAvatarMood(item.state)} />
      </span>
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
        ) : hasTasks ? (
          <button
            type="button"
            className={`bot-expand-chevron${expanded ? ' is-open' : ''}`}
            aria-label={expanded ? (isZh ? '收起任务' : 'Collapse tasks') : (isZh ? '展开任务' : 'Expand tasks')}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand?.(item.workspaceId);
            }}
          >
            <PeerIcon name="chevronRight" size={12} />
          </button>
        ) : null}
      </span>
    </div>
  );
});
