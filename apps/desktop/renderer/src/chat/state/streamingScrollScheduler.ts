import type { FrameScheduler } from './frameCoalescer.ts';

export interface StreamingScrollScheduler {
  /** 请求「贴底」：同一帧内首次立即提交，其余合并丢弃。 */
  scheduleFollow(): void;
  /** 请求「刷新滚动状态」（不贴底，仅重算底部状态与当前轮次上下文）。 */
  scheduleRefresh(): void;
  /** 丢弃尚未执行的请求（卸载/切会话时调用）。 */
  cancel(): void;
}

/**
 * 流式追加期间的滚动调度器。
 *
 * 背景：每个流式 delta 都会写入会话状态，而 `messages` 换引用会触发 ChatSurface 的
 * useLayoutEffect 提交一次滚动。每次提交内部包含多次「强制同步布局」
 * （scrollHeight / getBoundingClientRect / elementFromPoint 命中测试）。输出快时每秒
 * 几十次，主线程被布局吃满，整个界面一起卡住。所以要收敛到「每帧最多一次」。
 *
 * 关键：收敛必须用「前沿同步」而不是「整体推迟到下一帧 rAF」。
 * 调用方是 useLayoutEffect，它发生在 React 提交之后、本帧绘制之前——在这里同步贴底
 * 天然是「先滚再画」，观感无跳变。若改成一律推迟到 rAF，一旦 store 写入发生在浏览器
 * 该帧 rAF 阶段之后（IPC 消息回调属于任务态，完全可能），rAF 回调就会落到下一帧，
 * 于是出现「内容先露出、下一帧才滚」的可见跳动。
 *
 * 因此这里的语义是：
 *  - 本帧第一次请求 → 立即同步提交（保证不跳）；
 *  - 同帧后续请求 → 丢弃（它们要贴的是同一个底，重复提交没有意义）；
 *  - 用一次 rAF 在下一帧开始时重置标记，避免永久锁死。
 *
 * 两种意图各占一个标记：贴底与刷新互不顶掉（共用合并器时后来者会覆盖先到者，
 * 导致正在跟随时偶发少贴一帧）。
 */
export function createStreamingScrollScheduler(input: {
  readonly scheduler: FrameScheduler;
  readonly follow: () => void;
  readonly refresh: () => void;
}): StreamingScrollScheduler {
  /** 本帧是否已提交过；由 frameResetHandle 在下一帧开始时复位。 */
  let followCommittedThisFrame = false;
  let refreshCommittedThisFrame = false;
  let frameResetHandle: number | null = null;
  let cancelled = false;

  const scheduleFrameReset = () => {
    if (frameResetHandle !== null) return;
    frameResetHandle = input.scheduler.request(() => {
      frameResetHandle = null;
      followCommittedThisFrame = false;
      refreshCommittedThisFrame = false;
    });
  };

  return {
    scheduleFollow() {
      if (cancelled) return;
      if (followCommittedThisFrame) return; // 同帧已贴过底
      followCommittedThisFrame = true;
      scheduleFrameReset();
      input.follow();
    },
    scheduleRefresh() {
      if (cancelled) return;
      if (refreshCommittedThisFrame) return;
      refreshCommittedThisFrame = true;
      scheduleFrameReset();
      input.refresh();
    },
    cancel() {
      cancelled = true;
      if (frameResetHandle !== null) {
        input.scheduler.cancel(frameResetHandle);
        frameResetHandle = null;
      }
      followCommittedThisFrame = false;
      refreshCommittedThisFrame = false;
    },
  };
}
