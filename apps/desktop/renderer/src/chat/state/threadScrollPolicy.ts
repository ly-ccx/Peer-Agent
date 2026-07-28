/**
 * 主线程/消息轨在消息结构变化后的滚动策略（纯函数，便于单测）。
 *
 * 压缩完成后 messages 会被整表重写：条数通常骤降，旧的按 index 缓存高度与新时间线错位。
 * 此时若仍用错误 totalSize 贴底，浏览器可能把 scrollTop 钳到 0，随后高度回升却停在顶部。
 */

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
