import { IDLE_COMPACTION_STATE, type CompactionProgressStage, type CompactionState } from './types.ts';

export type CompactionLifecycleEvent =
  | { readonly stage: 'start'; readonly streamId: string; readonly now: number }
  | {
      readonly stage: 'progress';
      readonly streamId: string;
      readonly percent: number | null;
      readonly progressStage?: CompactionProgressStage;
      readonly attempt?: number;
      readonly maxAttempts?: number;
      readonly inputTokenBudget?: number;
      readonly now: number;
    }
  | { readonly stage: 'finalizing'; readonly streamId: string; readonly now: number }
  | { readonly stage: 'idle'; readonly streamId: string };

function belongsToAnotherActiveStream(state: CompactionState, streamId: string): boolean {
  return state.phase !== 'idle' && Boolean(state.streamId && state.streamId !== streamId);
}

/**
 * 压缩生命周期的会话内状态归并器。
 *
 * IPC 事件和完成后延时器都可能晚于下一轮压缩抵达。除 start 明确开启新一轮外，
 * terminal/progress 事件只能修改相同 streamId 的状态，防止旧任务把新任务清成 idle。
 */
export function reduceCompactionLifecycle(
  state: CompactionState,
  event: CompactionLifecycleEvent,
): CompactionState {
  if (event.stage === 'start') {
    // 新一轮压缩开始：无条件覆盖（含 phase:'failed'），让失败态可被下一次压缩恢复。
    return {
      phase: 'running',
      percent: null,
      streamId: event.streamId,
      startedAt: event.now,
    };
  }

  if (belongsToAnotherActiveStream(state, event.streamId)) return state;

  // idle 是终端事件：同 streamId 时把 failed / finalizing / running 一律复位为 idle，
  // 保证失败横幅可被主进程后续的 idle 通知关闭（failed 状态不永久残留）。
  if (event.stage === 'idle') return IDLE_COMPACTION_STATE;
  if (event.stage === 'finalizing') {
    return {
      phase: 'finalizing',
      percent: 100,
      streamId: event.streamId,
      completedAt: event.now,
    };
  }

  const previousRunning = state.phase === 'running' ? state : null;
  const progressStage = event.progressStage ?? previousRunning?.progressStage;
  const attempt = event.attempt ?? previousRunning?.attempt;
  const maxAttempts = event.maxAttempts ?? previousRunning?.maxAttempts;
  const inputTokenBudget = event.inputTokenBudget ?? previousRunning?.inputTokenBudget;
  return {
    phase: 'running',
    percent: event.percent ?? previousRunning?.percent ?? null,
    ...(progressStage ? { progressStage } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(inputTokenBudget !== undefined ? { inputTokenBudget } : {}),
    streamId: event.streamId,
    startedAt: state.phase === 'running' && state.streamId === event.streamId
      ? state.startedAt
      : event.now,
  };
}
