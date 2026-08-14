/**
 * TaskOverview 广播节流调度器。
 *
 * 背景（2026-08-14 trace 实测，见 peer-knowledge multi-task-ui-performance-remediation.md §12）：
 * 多任务并发时，conversations/automations/goalPlans 三类变更以 ~300ms 周期互相触发，
 * 每次都 fan-out 广播 taskOverview:changed，renderer 收到后全量重拉 IPC，
 * main 进程同步聚合（listPlans 全量 normalize）被打满（84% 负载），形成自激循环。
 *
 * 治理契约：
 * - 最小广播间隔 minIntervalMs（默认 2s）：窗口内的多次变更合并为一次广播。
 * - 合并期间聚合 scope（reason 集合 + planIds/conversationIds，各截断至 maxScopeIds）：
 *   renderer 可据此判断"与我无关的变更不重拉"。
 * - scope 收敛：当任一集合超过 maxScopeIds（默认 8）即视为风暴，退化为"全量 scope"
 *   （ids 置空 + scoped:false），renderer 一律重拉，避免 payload 无界增长。
 * - trailing 保证：最后一次请求后的 minIntervalMs 内必然发出广播，不丢变更通知。
 * - flush()：app 退出 / 单测断言前同步收口。
 */

export const TASK_OVERVIEW_MIN_INTERVAL_MS = 2_000;
export const TASK_OVERVIEW_MAX_SCOPE_IDS = 8;

/**
 * @param {object} options
 * @param {(channel: string, payload: object) => void} options.broadcast
 * @param {number} [options.minIntervalMs] 最小广播间隔，默认 2000
 * @param {number} [options.maxScopeIds] scope id 截断上限，默认 8
 * @param {() => number} [options.now] 时间源（单测注入）
 * @param {(fn: () => void, ms: number) => object} [options.setTimer] 定时器实现（单测注入）
 * @param {(timer: object) => void} [options.clearTimer] 清除定时器（单测注入）
 */
export function createTaskOverviewBroadcastScheduler({
  broadcast,
  minIntervalMs = TASK_OVERVIEW_MIN_INTERVAL_MS,
  maxScopeIds = TASK_OVERVIEW_MAX_SCOPE_IDS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  if (typeof broadcast !== 'function') {
    throw new TypeError('createTaskOverviewBroadcastScheduler: broadcast is required');
  }

  let lastBroadcastAt = -Infinity;
  let pending = null; // { reasons: Set<string>, planIds: Set<string>, conversationIds: Set<string> }
  let timer = null;
  let flushed = false;

  function mergeInto(set, value) {
    if (typeof value !== 'string' || !value) return;
    set.add(value);
  }

  function emit() {
    timer = null;
    if (!pending) return;
    const payload = pending;
    pending = null;
    lastBroadcastAt = now();
    broadcast('taskOverview:changed', {
      reason: payload.reasons.size === 1 ? [...payload.reasons][0] : 'merged',
      reasons: [...payload.reasons],
      planIds: payload.scoped ? [...payload.planIds] : [],
      conversationIds: payload.scoped ? [...payload.conversationIds] : [],
      scoped: payload.scoped,
    });
  }

  function schedule(delayMs) {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => emit(), delayMs);
  }

  return {
    /**
     * 请求一次 taskOverview:changed 广播。
     * @param {{ reason?: string, planId?: string | null, conversationId?: string | null }} [request]
     */
    request(request = {}) {
      if (flushed) return;
      const reasons = pending ? pending.reasons : new Set();
      const planIds = pending ? pending.planIds : new Set();
      const conversationIds = pending ? pending.conversationIds : new Set();
      if (request.reason) reasons.add(String(request.reason));
      mergeInto(planIds, request.planId);
      mergeInto(conversationIds, request.conversationId);

      const overLimit =
        planIds.size > maxScopeIds || conversationIds.size > maxScopeIds;
      pending = {
        reasons,
        planIds,
        conversationIds,
        scoped: (pending ? pending.scoped : true) && !overLimit,
      };

      const elapsed = now() - lastBroadcastAt;
      if (elapsed >= minIntervalMs) {
        // 冷路径：距上次广播已超过最小间隔，立即发出（同时取消排队中的 trailing）。
        schedule(0);
      } else if (timer === null) {
        // 热路径首次进入窗口：安排 trailing 定时器到最小间隔边界；
        // 后续窗口内的请求只合并不重置定时器，保证 trailing 必然发出且风暴不被无限推迟。
        schedule(minIntervalMs - elapsed);
      }
    },

    /** 同步发出挂起的广播（退出前/测试断言前调用）。 */
    flush() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (pending) emit();
    },

    /** 停止调度（app quit）。 */
    dispose() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = null;
      flushed = true;
    },

    get pendingCount() {
      return pending ? pending.reasons.size : 0;
    },
  };
}
