import type { BotListItem } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import { formatBotListTime } from './state/botListState';
import { botListKey } from './state/botListKeyboard';
import { BotRow } from './BotRow';
import { BotSidebarTasks } from './BotSidebarTasks';
import type { BotAvatarMood } from './state/botAvatarState';
import type { DrawerSession } from './state/drawerState';
import { sidebarActiveSessionsOf } from './state/botNavigationState';

interface BotListProps {
  readonly items: readonly BotListItem[];
  readonly avatarMoods?: ReadonlyMap<string, BotAvatarMood>;
  readonly highlightedId: string | null;
  readonly openedId: string | null;
  readonly activeSessionId?: string | null;
  readonly openedLiveSessions?: readonly DrawerSession[] | null;
  readonly expandedBots?: Readonly<Record<string, boolean>>;
  readonly expandedMoreBots?: Readonly<Record<string, boolean>>;
  readonly emptyLabel: string;
  readonly i18n: I18nRuntime;
  readonly onHighlight: (workspaceId: string) => void;
  readonly onAttention?: (workspaceId: string) => void;
  readonly onOpen: (workspaceId: string) => void;
  readonly onToggleExpand?: (workspaceId: string) => void;
  readonly onToggleMoreTasks?: (workspaceId: string) => void;
  readonly onOpenTask?: (workspaceId: string, sessionId: string) => void;
  readonly now?: number;
}

export function BotList({
  items,
  avatarMoods,
  highlightedId,
  openedId,
  activeSessionId = null,
  openedLiveSessions = null,
  expandedBots = {},
  expandedMoreBots = {},
  emptyLabel,
  i18n,
  onHighlight,
  onOpen,
  onAttention,
  onToggleExpand,
  onToggleMoreTasks,
  onOpenTask,
  now,
}: BotListProps) {
  return (
    <div
      id="bot-list"
      className="bot-list"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.isDefaultPrevented() || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && highlightedId && onToggleExpand) {
          const isOpen = expandedBots[highlightedId] === true;
          if ((event.key === 'ArrowRight' && !isOpen) || (event.key === 'ArrowLeft' && isOpen)) {
            event.preventDefault();
            onToggleExpand(highlightedId);
            return;
          }
        }
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
      ) : items.map((item) => {
        const live = item.workspaceId === openedId ? openedLiveSessions : null;
        const active = sidebarActiveSessionsOf(item, live);
        const hasTasks = active.items.length > 0;
        const expanded = hasTasks && (expandedBots[item.workspaceId] ?? item.workspaceId === openedId);
        const isBotViewSelected = item.workspaceId === openedId && !activeSessionId;
        return (
          <div key={item.workspaceId} className={`bot-group${expanded ? ' is-expanded' : ''}`}>
            <BotRow
              item={item}
              avatarMood={avatarMoods?.get(item.workspaceId)}
              highlighted={item.workspaceId === highlightedId}
              opened={isBotViewSelected}
              hasTasks={hasTasks}
              expanded={expanded}
              timeLabel={formatBotListTime(item.lastActiveAt, now)}
              i18n={i18n}
              onOpen={onOpen}
              onAttention={onAttention}
              onToggleExpand={onToggleExpand}
            />
            {expanded && onOpenTask ? (
              <BotSidebarTasks
                workspaceId={item.workspaceId}
                botName={item.profile.displayName}
                tasks={active.items}
                total={active.total}
                activeSessionId={item.workspaceId === openedId ? activeSessionId : null}
                expandedMore={expandedMoreBots[item.workspaceId] === true}
                i18n={i18n}
                onOpenTask={onOpenTask}
                onToggleMore={(wsId) => onToggleMoreTasks?.(wsId)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
