import type { SegmentGroup } from './types';

export interface ProcessExpansionState {
  readonly expanded: boolean;
  readonly isActive: boolean;
  readonly userOverrodeActiveExpansion: boolean;
}

export function createProcessExpansionState(isActive: boolean): ProcessExpansionState {
  return {
    expanded: false,
    isActive,
    userOverrodeActiveExpansion: false,
  };
}

export function updateProcessActivity(
  state: ProcessExpansionState,
  isActive: boolean,
): ProcessExpansionState {
  if (state.isActive === isActive) return state;

  if (!isActive) {
    return {
      expanded: false,
      isActive,
      userOverrodeActiveExpansion: state.userOverrodeActiveExpansion,
    };
  }

  // 进行中默认也收起：折叠条只显示「正在思考」，
  // 完整过程只在用户手动展开时显示，避免工具调用出现时整段突然铺开。
  return {
    expanded: state.userOverrodeActiveExpansion ? state.expanded : false,
    isActive,
    userOverrodeActiveExpansion: state.userOverrodeActiveExpansion,
  };
}

export function toggleProcessExpansion(state: ProcessExpansionState): ProcessExpansionState {
  return {
    ...state,
    expanded: !state.expanded,
    // 默认收起语义下，任何手动切换（无论开/关）都视为用户接管展开状态：
    // 之后流式活跃度变化不再自动改写，仅完成（isActive→false）时统一收口。
    userOverrodeActiveExpansion: true,
  };
}

function isProcessingGroup(group: SegmentGroup): boolean {
  return group.type === 'thinking' || group.type === 'tool-call-group';
}

/**
 * 过程区是否仍在进行。
 *
 * 流式协议没有“这段 text 已经是最终正文”的中间态事实；模型可能在任意说明文字之后
 * 继续 thinking / tool call。因此一旦本轮出现过程段，整个 streaming 生命周期都保持
 * 同一时间线和展开状态，只在 done / error / abort 使 isStreaming=false 后统一收口。
 */
export function isProcessTimelineActive(
  groups: readonly SegmentGroup[],
  isStreaming: boolean,
): boolean {
  return isStreaming && groups.some(isProcessingGroup);
}
