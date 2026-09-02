import type { QueuedMessage } from './types';

/** Goal Runner 占用会话时，自动出队必须让路。 */
export const GOAL_RUNNER_HOLD_STATUSES = Object.freeze([
  'running',
  'exploring',
  'compacting_context',
  'resuming_after_compaction',
] as const);

export type GoalRunnerHoldStatus = (typeof GOAL_RUNNER_HOLD_STATUSES)[number];

export function isGoalRunnerHoldingQueue(status: string | null | undefined): boolean {
  return status != null && (GOAL_RUNNER_HOLD_STATUSES as readonly string[]).includes(status);
}

/**
 * 队列只允许在当前会话已经完成加载与流状态重连后自动发送。
 *
 * `isStreaming === false` 本身不能代表会话空闲：切换会话时 renderer 会先把它归零，
 * 再异步向 main 进程 reattach。streamStatus 保持 unknown 直到 reattach 收敛，用来区分
 * 「确认空闲」和「流状态尚未知」。Goal Runner 占用会话时同样不能把 tick 交接窗口当成空闲。
 */
export function canAutoDispatchQueuedMessage(input: {
  readonly loadStatus: 'idle' | 'loading' | 'ready';
  readonly streamStatus?: 'unknown' | 'confirmed';
  readonly isStreaming: boolean;
  readonly isCompactionActive: boolean;
  readonly hasProvider: boolean;
  readonly hasConversation: boolean;
  readonly hasResumeTask: boolean;
  readonly queueLength: number;
  readonly goalRunnerStatus?: string | null;
}): boolean {
  return input.loadStatus === 'ready'
    && (input.streamStatus ?? 'confirmed') === 'confirmed'
    && !input.isStreaming
    && !input.isCompactionActive
    && !isGoalRunnerHoldingQueue(input.goalRunnerStatus)
    && input.hasProvider
    && input.hasConversation
    && !input.hasResumeTask
    && input.queueLength > 0;
}

/**
 * 发送被明确接受后才删除队首。调用失败或返回 false 时不触碰队列，避免先 shift 后因
 * load/stream 前置条件变化而永久丢消息。
 */
export async function dispatchQueuedMessage(input: {
  readonly message: QueuedMessage;
  readonly submit: (message: QueuedMessage) => Promise<boolean>;
  readonly remove: (messageId: string) => void;
}): Promise<boolean> {
  const accepted = await input.submit(input.message);
  if (accepted) input.remove(input.message.id);
  return accepted;
}
