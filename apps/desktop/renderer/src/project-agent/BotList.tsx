import type { BotListItem } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import { formatBotListTime } from './state/botListState';
import { botListKey } from './state/botListKeyboard';
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
      id="bot-list"
      className="bot-list"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.isDefaultPrevented() || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        const action = botListKey(items.map(item => item.workspaceId), highlightedId, event.key);
        if (!action) return;
        event.preventDefault();
        onHighlight(action.id);
        if (action.open) onOpen(action.id);
        document.getElementById(`bot-row-${action.id}`)?.scrollIntoView({ block: 'nearest' });
      }}
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
