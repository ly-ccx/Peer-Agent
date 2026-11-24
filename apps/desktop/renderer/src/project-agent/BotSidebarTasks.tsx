import { memo } from 'react';
import type { I18nRuntime } from '@peer-agent/i18n';
import { PeerIcon } from '../ui/icons';
import type { SidebarTaskEntry } from './state/botNavigationState';

const DEFAULT_VISIBLE = 3;

function taskVisual(task: SidebarTaskEntry, isZh: boolean): {
  icon: 'loader' | 'warning' | 'circle';
  spin: boolean;
  tone: 'warn' | 'danger' | 'azure' | 'muted';
  tag: string;
} {
  if (task.followUp?.owner === 'user' || task.status === 'waiting_user') {
    return { icon: 'warning', spin: false, tone: 'warn', tag: isZh ? '待批' : 'Action' };
  }
  if (task.followUp?.reason === 'verification_failed') {
    return { icon: 'warning', spin: false, tone: 'danger', tag: isZh ? '重验' : 'Re-verify' };
  }
  if (task.status === 'failed') {
    return { icon: 'warning', spin: false, tone: 'danger', tag: isZh ? '失败' : 'Failed' };
  }
  if (task.status === 'verifying' || (task.status === 'result_ready' && task.followUp?.owner === 'bot')) {
    return { icon: 'loader', spin: true, tone: 'azure', tag: isZh ? '核验' : 'Verify' };
  }
  if (task.status === 'queued') {
    return { icon: 'circle', spin: false, tone: 'muted', tag: '' };
  }
  return { icon: 'loader', spin: true, tone: 'azure', tag: '' };
}

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
  const hiddenCount = Math.max(0, total - visible.length);

  return (
    <div
      className="bot-sidebar-tasks"
      role="group"
      aria-label={isZh ? `${botName} 进行中的任务` : `${botName} active tasks`}
    >
      {visible.map((task) => {
        const visual = taskVisual(task, isZh);
        const selected = activeSessionId === task.sessionId;
        return (
          <button
            key={task.sessionId}
            type="button"
            className={`bot-sidebar-task${selected ? ' is-selected' : ''}`}
            data-session-id={task.sessionId}
            aria-current={selected ? 'page' : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onOpenTask(workspaceId, task.sessionId);
            }}
          >
            <span className="bot-sidebar-task-glyph" data-tone={visual.tone} aria-hidden="true">
              <PeerIcon
                name={visual.icon}
                size={13}
                className={visual.spin ? 'motion-spin' : undefined}
              />
            </span>
            <span className="bot-sidebar-task-title">{task.title}</span>
            {visual.tag ? (
              <span className="bot-sidebar-task-tag" data-tone={visual.tone}>
                {visual.tag}
              </span>
            ) : null}
          </button>
        );
      })}
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="bot-sidebar-task-more"
          onClick={(event) => {
            event.stopPropagation();
            onToggleMore(workspaceId);
          }}
        >
          <span>{isZh ? `其余 ${hiddenCount} 项进行中` : `${hiddenCount} more active`}</span>
          <span>{isZh ? '展开' : 'Show'}</span>
        </button>
      ) : expandedMore && tasks.length > DEFAULT_VISIBLE ? (
        <button
          type="button"
          className="bot-sidebar-task-more"
          onClick={(event) => {
            event.stopPropagation();
            onToggleMore(workspaceId);
          }}
        >
          <span>{isZh ? `仅显示前 ${DEFAULT_VISIBLE} 项` : `Show top ${DEFAULT_VISIBLE}`}</span>
          <span>{isZh ? '收起' : 'Less'}</span>
        </button>
      ) : null}
    </div>
  );
});
