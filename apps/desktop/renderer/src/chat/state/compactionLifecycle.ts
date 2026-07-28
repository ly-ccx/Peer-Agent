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
    return {
      phase: 'running',
      percent: null,
      streamId: event.streamId,
      startedAt: event.now,
    };
  }

  if (belongsToAnotherActiveStream(state, event.streamId)) return state;

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
