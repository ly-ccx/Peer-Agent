import type { CompactionState } from './types';

export type SidebarConversationActivity =
  | { kind: 'compaction'; state: Exclude<CompactionState, { phase: 'idle' }> }
  | { kind: 'running' }
  | { kind: 'idle' };

export function isVisibleCompactionState(
  state: CompactionState | null | undefined,
): state is Exclude<CompactionState, { phase: 'idle' }> {
  return Boolean(state && state.phase !== 'idle');
}

export function compactionProgressPercent(state: CompactionState | null | undefined): number | null {
  return isVisibleCompactionState(state) ? state.percent : null;
}

export function sidebarConversationActivity(params: {
  readonly isRunning: boolean;
  readonly compactionState: CompactionState | null | undefined;
}): SidebarConversationActivity {
  if (isVisibleCompactionState(params.compactionState)) {
    return { kind: 'compaction', state: params.compactionState };
  }
  return params.isRunning ? { kind: 'running' } : { kind: 'idle' };
}

export function compactionStateLabel(state: CompactionState | null | undefined, isZh: boolean): string {
  if (state?.phase === 'failed') return isZh ? '压缩失败' : 'Compaction failed';
  if (state?.phase === 'finalizing') return isZh ? '刷新上下文中' : 'Refreshing context';
  if (state?.phase === 'running') return isZh ? '压缩上下文中' : 'Compacting context';
  return isZh ? '压缩上下文中' : 'Compacting context';
}

export function sidebarCompactionStateLabel(state: CompactionState | null | undefined, isZh: boolean): string {
  if (state?.phase === 'failed') return isZh ? '压缩失败' : 'Compaction failed';
  if (state?.phase === 'finalizing') return isZh ? '刷新上下文' : 'Refreshing context';
  return isZh ? '压缩中' : 'Compacting';
}
