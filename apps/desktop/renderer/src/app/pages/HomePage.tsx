import { useCallback, type MutableRefObject } from 'react';
import type { TaskOverviewItem } from '@peer-agent/protocol';
import { useWorkbenchOptional } from '../../workbench/WorkbenchContext';
import type { OpenTaskOverviewItem } from '../state/resultDrawerAcceptance';
import { TaskOverviewPage } from './TaskOverviewPage';

/**
 * 工作台页：只回答「现在轮到我做什么」。
 * 折叠头部状态 isHeaderCompact 由 TaskOverviewPage 内的实际滚动容器统一维护。
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
  acceptHandlerRef,
  onCancelItem,
  onOpenTools,
  enabled = true,
}: {
  /** null = 全部工作区；有 path = 仅该工作区。 */
  readonly workspacePath?: string | null;
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  /** 空态「发起新任务」：跳到新建任务页（与侧栏新建任务一致）。 */
  readonly onNewTask?: () => void;
  readonly onOpenItem?: OpenTaskOverviewItem;
  /** 工作台一键确认验收（落库 resultAcceptance）。 */
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  readonly acceptHandlerRef?: MutableRefObject<((item: TaskOverviewItem) => void | Promise<void>) | null>;
  /** 取消正在推进的 GoalPlan。 */
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
  /** 区级摘要跳到侧栏「插件」页。 */
  readonly onOpenTools?: () => void;
  readonly enabled?: boolean;
}) {
  const workbench = useWorkbenchOptional();
  const isGlobal = !workspacePath;

  const handleOpenItem = useCallback<OpenTaskOverviewItem>((item, options) => {
    // 后台 shell 线程：打开右侧「后台线程」Tab，不跳会话。
    if (
      item.source === 'shell_background' ||
      item.nextAction === 'open_background_thread'
    ) {
      workbench?.openBackgroundThread(item.taskId);
      return;
    }
    onOpenItem?.(item, options);
  }, [onOpenItem, workbench]);

  return (
    <TaskOverviewPage
      title="工作台"
      subtitle={
        isGlobal
          ? '一张卡是一件事。点进去继续这件事。'
          : '一张卡是一件事。点进去继续这件事。'
      }
      filter={(item) => item.actionRight !== 'terminal'}
      emptyLabel={
        isGlobal
          ? '还没有任务。发出第一条后，这里会显示需要你处理的事项。'
          : '当前工作区还没有任务。发出第一条后会显示在这里。'
      }
      hero
      enabled={enabled}
      workspacePath={workspacePath}
      onOpenTasks={onOpenTasks}
      onOpenHistory={onOpenHistory}
      onNewTask={onNewTask}
      onOpenItem={handleOpenItem}
      onAcceptResult={onAcceptResult}
      acceptHandlerRef={acceptHandlerRef}
      onCancelItem={onCancelItem}
      onOpenTools={onOpenTools}
    />
  );
}
