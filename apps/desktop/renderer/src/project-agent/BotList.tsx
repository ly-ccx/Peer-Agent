import type { BotListItem } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import { formatBotListTime } from './state/botListState';
import { BotRow } from './BotRow';

interface BotListProps {
  readonly items: readonly BotListItem[];
  readonly highlightedId: string | null;
  readonly openedId: string | null;
  readonly emptyLabel: string;
  readonly i18n: I18nRuntime;
  readonly onHighlight: (workspaceId: string) => void;
  readonly onOpen: (workspaceId: string) => void;
  readonly now?: number;
}

export function BotList({
  items,
  highlightedId,
  openedId,
  emptyLabel,
  i18n,
  onHighlight,
  onOpen,
  now,
}: BotListProps) {
  return (
    <div
      className="bot-list"
      role="listbox"
      aria-label={i18n.t('projectAgent.list.brand')}
      aria-activedescendant={highlightedId ? `bot-row-${highlightedId}` : undefined}
    >
      {items.length === 0 ? (
        <p className="bot-list-empty">{emptyLabel}</p>
      ) : items.map((item) => (
        <BotRow
          key={item.workspaceId}
          item={item}
          highlighted={item.workspaceId === highlightedId}
          opened={item.workspaceId === openedId}
          timeLabel={formatBotListTime(item.lastActiveAt, now)}
          i18n={i18n}
          onHighlight={onHighlight}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
