import type { TaskOverviewItem } from '@peer-agent/protocol';
import { TaskOverviewPage } from './TaskOverviewPage';

/** 工作台：跨任务行动中心，只回答「现在需要关注什么」。 */
export function HomePage({
  workspacePath = null,
  onOpenTasks,
  onOpenHistory,
  onOpenItem,
  onAcceptResult,
  onCancelItem,
}: {
  readonly workspacePath?: string | null;
  readonly onOpenTasks?: () => void;
  readonly onOpenHistory?: () => void;
  readonly onOpenItem?: (item: TaskOverviewItem) => void;
  /** 工作台一键确认验收（落库 resultAcceptance）。 */
  readonly onAcceptResult?: (item: TaskOverviewItem) => void | Promise<void>;
  /** 取消正在推进的 GoalPlan。 */
  readonly onCancelItem?: (item: TaskOverviewItem) => void | Promise<void>;
}) {
  return (
    <TaskOverviewPage
      title="工作台"
      subtitle="Peer 持续推进任务，仅在需要你决策、授权或验收时交还给你。"
      filter={(item) => item.actionRight !== 'terminal'}
      emptyLabel="当前没有需要处理的任务"
      hero
      workspacePath={workspacePath}
      onOpenTasks={onOpenTasks}
      onOpenHistory={onOpenHistory}
      onOpenItem={onOpenItem}
      onAcceptResult={onAcceptResult}
      onCancelItem={onCancelItem}
    />
  );
}
