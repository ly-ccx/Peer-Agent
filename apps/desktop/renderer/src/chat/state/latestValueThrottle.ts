/**
 * 「最新值优先」的写入节流器。
 *
 * 用途：外部事件（IPC 流事件、埋点推送等）可能以每秒几百次的速率到达，而每次写入
 * 会话状态都会同步通知订阅者并触发一次 React 重渲染。若把事件速率直接当写入速率，
 * 渲染压力就会随输出速度线性增长，最终把 React 的嵌套更新推过上限（本项目实际报过
 * `Maximum update depth exceeded`）。
 *
 * 语义（不是简单的丢弃中间值）：
 * - 同一 key 的多次 push 只保留最后一个值 —— 中间值对「最新快照」类数据没有意义；
 * - 距上次提交已超过 interval 时立即提交，避免首个值被拖延；
 * - 否则安排一次尾部提交，保证最后一个值一定会落库（不会丢）；
 * - 不同 key 各自保留最新值，互不影响。
 */

export interface LatestValueThrottle<Key, Value> {
  /** 记录某 key 的最新值；按时序决定立即提交还是尾部提交。 */
  push(key: Key, value: Value): void;
  /** 立即提交所有待提交值（流结束、卸载前调用）。 */
  flush(): void;
  /** 丢弃待提交值与定时器（切会话/卸载）。 */
  cancel(): void;
}

export interface LatestValueThrottleOptions<Key, Value> {
  /** 两次提交之间的最小间隔（毫秒）。 */
  readonly intervalMs: number;
  /** 真正的落库动作。 */
  readonly commit: (key: Key, value: Value) => void;
  /** 时钟（便于测试注入）。 */
  readonly now?: () => number;
  /** 定时器（便于测试注入）。返回句柄。 */
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export function createLatestValueThrottle<Key, Value>(
  options: LatestValueThrottleOptions<Key, Value>,
): LatestValueThrottle<Key, Value> {
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

  const pending = new Map<Key, Value>();
  let timer: unknown = null;
  let lastCommitAtMs = 0;

  const commitAll = () => {
    timer = null;
    if (pending.size === 0) return;
    const batch = Array.from(pending.entries());
    pending.clear();
    lastCommitAtMs = now();
    for (const [key, value] of batch) options.commit(key, value);
  };

  const scheduleTrailing = () => {
    if (timer !== null) return;
    const elapsed = now() - lastCommitAtMs;
    const remaining = Math.max(0, options.intervalMs - elapsed);
    timer = setTimer(() => commitAll(), remaining);
  };

  return {
    push(key, value) {
      if (now() - lastCommitAtMs >= options.intervalMs) {
        // 距上次提交已够久：立刻提交，避免首个值被拖延一个完整间隔。
        pending.delete(key);
        lastCommitAtMs = now();
        options.commit(key, value);
        return;
      }
      pending.set(key, value);
      scheduleTrailing();
    },
    flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      commitAll();
    },
    cancel() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending.clear();
    },
  };
}
