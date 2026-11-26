import { memo } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { ExecutorIcon, executorDisplayName } from './ExecutorIcon';
import type { SidebarTaskEntry } from './state/botNavigationState';
import { workerStatus } from './state/workerStatus';

const DEFAULT_VISIBLE = 4;

export interface BotSidebarTasksProps {
  readonly workspaceId: string;
  readonly botName: string;
  readonly tasks: readonly SidebarTaskEntry[];
  readonly total: number;
  readonly activeSessionId: string | null;
  readonly expandedMore: boolean;
  readonly i18n: I18nRuntime;
  readonly onOpenTask: (workspaceId: string, sessionId: string) => void;
  readonly onToggleMore: (workspaceId: string) => void;
}

export const BotSidebarTasks = memo(function BotSidebarTasks({
  workspaceId,
  botName,
  tasks,
  total,
  activeSessionId,
  expandedMore,
  i18n,
  onOpenTask,
  onToggleMore,
}: BotSidebarTasksProps) {
  if (tasks.length === 0) return null;
  const isZh = i18n.locale.startsWith('zh');
  const visible = expandedMore ? tasks : tasks.slice(0, DEFAULT_VISIBLE);
  const hiddenCount = Math.max(0, total - DEFAULT_VISIBLE);

  return (
    <div
      className="bot-sidebar-tasks"
      role="group"
      aria-label={isZh ? `${botName} 进行中的任务` : `${botName} active tasks`}
    >
      {visible.map((task) => {
        const visual = workerStatus(task.status, task.followUp, i18n);
        const selected = activeSessionId === task.sessionId;
        return (
          <button
            key={task.sessionId}
            type="button"
            className={`bot-sidebar-task${selected ? ' is-selected' : ''}`}
            data-session-id={task.sessionId}
            data-task-tone={visual.tone}
            title={`${task.title} · ${visual.text}`}
            aria-label={`${task.title} · ${visual.text} · ${executorDisplayName('peer', isZh)}`}
            aria-current={selected ? 'page' : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onOpenTask(workspaceId, task.sessionId);
            }}
          >
            <ExecutorIcon className="bot-sidebar-task-cli" flowing={visual.tone === 'active'} />
            <span className="bot-sidebar-task-title">{task.title}</span>
          </button>
        );
      })}
      {tasks.length > DEFAULT_VISIBLE ? (
        <button
          type="button"
          className="bot-sidebar-task-more"
          aria-expanded={expandedMore}
          onClick={(event) => {
            event.stopPropagation();
            onToggleMore(workspaceId);
          }}
        >
          {expandedMore
            ? (isZh ? '收起部分任务' : 'Show fewer')
            : (isZh ? `再显示 ${hiddenCount} 个任务` : `Show ${hiddenCount} more`)}
        </button>
      ) : null}
    </div>
  );
});
