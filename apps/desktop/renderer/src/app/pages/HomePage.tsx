import { useCallback } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { useWorkbenchOptional } from '../../workbench/WorkbenchContext';
import { TaskOverviewPage } from './TaskOverviewPage';

/**
 * 工作台页：只回答「现在需要关注什么」。
 *
 * 侧栏两套入口（勿混）：
 * - 顶部「工作台」→ workspacePath=null，跨工作区全部行动权
 * - 下方某个工作区 → 传入该区 path，只看该区；同时激活该区作新任务落点
 */
export function HomePage({
  workspacePath = null,
  onOpenTasks,
  onOpenHistory,
  onNewTask,
  onOpenItem,
  onAcceptResult,
  onCancelItem,
}: {
  /** null = 全部工作区；有 path = 仅该工作区。 */
  readonly workspacePath?: string | null;
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  /** 空态「发起新任务」：跳到新建任务页（与侧栏新建任务一致）。 */
  readonly onNewTask?: () => void;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  /** 工作台一键确认验收（落库 resultAcceptance）。 */
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  /** 取消正在推进的 GoalPlan。 */
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
}) {
  const workbench = useWorkbenchOptional();
  const isGlobal = !workspacePath;

  const handleOpenItem = useCallback((item: TaskOverviewItem) => {
    // 后台 shell 线程：打开右侧「后台线程」Tab，不跳会话。
    if (
      item.source === 'shell_background' ||
      item.nextAction === 'open_background_thread'
    ) {
      workbench?.openBackgroundThread(item.taskId);
      return;
    }
    onOpenItem?.(item);
  }, [onOpenItem, workbench]);

  return (
    <TaskOverviewPage
      title="工作台"
      subtitle={
        isGlobal
          ? 'Peer 持续推进任务，仅在需要你决策、授权或验收时交还给你。跨工作区待办汇总在此。'
          : 'Peer 持续推进任务，仅在需要你决策、授权或验收时交还给你。当前工作区待办。'
      }
      filter={(item) => item.actionRight !== 'terminal'}
      emptyLabel={
        isGlobal
          ? '全部工作区都没有需要处理的任务'
          : '当前工作区没有需要处理的任务'
      }
      hero
      workspacePath={workspacePath}
      onOpenTasks={onOpenTasks}
      onOpenHistory={onOpenHistory}
      onNewTask={onNewTask}
      onOpenItem={handleOpenItem}
      onAcceptResult={onAcceptResult}
      onCancelItem={onCancelItem}
    />
  );
}
