/**
 * 主线程/消息轨在消息结构变化后的滚动策略（纯函数，便于单测）。
 *
 * 压缩完成后 messages 会被整表重写：条数通常骤降，旧的按 index 缓存高度与新时间线错位。
 * 此时若仍用错误 totalSize 贴底，浏览器可能把 scrollTop 钳到 0，随后高度回升却停在顶部。
 */

/**
 * 打开会话的默认落点：最新消息（底部）。
 * 查找 / 任务相关消息等显式锚点优先，不抢贴底。
 */
export function planThreadScrollOnConversationOpen(input: {
  readonly hasExplicitMessageTarget: boolean;
}): {
  readonly stickToBottom: boolean;
} {
  return { stickToBottom: !input.hasExplicitMessageTarget };
}

/** 消息条数下降视为结构重写（压缩/reload 的典型信号）。 */
export function isMessageStructureRewritten(
  previousCount: number,
  nextCount: number,
): boolean {
  return nextCount < previousCount;
}

/**
 * 结构重写且当前应自动贴底时：先清虚拟测量，再贴底（必要时多帧重试）。
 * 仅追加/替换时：只贴底，不清测量。
 */
export function planThreadScrollAfterMessagesChange(input: {
  readonly previousCount: number;
  readonly nextCount: number;
  readonly shouldAutoScroll: boolean;
}): {
  readonly stickToBottom: boolean;
  readonly resetVirtualMeasurements: boolean;
  readonly reaffirmFrames: number;
} {
  if (!input.shouldAutoScroll) {
    return {
      stickToBottom: false,
      resetVirtualMeasurements: false,
      reaffirmFrames: 0,
    };
  }

  const structureRewritten = isMessageStructureRewritten(
    input.previousCount,
    input.nextCount,
  );
  return {
    stickToBottom: true,
    resetVirtualMeasurements: structureRewritten,
    reaffirmFrames: structureRewritten ? 2 : 0,
  };
}

/** 消息轨列表在条目骤减后应贴到最新（底部）。 */
export function shouldStickMessageRailToLatest(
  previousItemCount: number,
  nextItemCount: number,
): boolean {
  if (nextItemCount === 0) return false;
  if (previousItemCount <= 0) return true;
  return nextItemCount < previousItemCount;
}

/**
 * 滚动事件后如何维护 stick-to-bottom / follow。
 *
 * 关键：
 * - 点「向下箭头」会进入 follow；
 * - 流式/虚拟列表重测会触发 scroll 且短暂离底；
 * - 若仅凭瞬时 distanceToBottom 清掉 follow，后续流式就不会再贴底，视口像瞬间回顶。
 *
 * 规则：
 * - 已在底部 → 进入/保持 follow；
 * - follow 中且用户手势导致离底 → 退出 follow；
 * - follow 中但非用户手势离底（内容增高、虚拟测量、程序滚动）→ 保持 follow 并 reaffirm；
 * - 非 follow 且未到底 → 保持离开。
 */
export function resolveThreadFollowAfterScroll(input: {
  readonly currentlyFollowing: boolean;
  readonly atBottom: boolean;
  readonly userInitiated: boolean;
}): {
  readonly nextFollowing: boolean;
  readonly shouldReaffirmBottom: boolean;
} {
  if (input.atBottom) {
    return {
      nextFollowing: true,
      shouldReaffirmBottom: false,
    };
  }

  if (!input.currentlyFollowing) {
    return {
      nextFollowing: false,
      shouldReaffirmBottom: false,
    };
  }

  if (input.userInitiated) {
    return {
      nextFollowing: false,
      shouldReaffirmBottom: false,
    };
  }

  return {
    nextFollowing: true,
    shouldReaffirmBottom: true,
  };
}
