import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskOverviewBroadcastScheduler } from './task-overview-broadcast.mjs';

/** 用虚拟时钟驱动调度器，验证合并/节流/scope/flush 契约。 */
function createHarness({ minIntervalMs = 2000, maxScopeIds = 8 } = {}) {
  const sent = [];
  let nowMs = 0;
  const timers = [];
  const scheduler = createTaskOverviewBroadcastScheduler({
    broadcast: (channel, payload) => sent.push({ at: nowMs, channel, payload }),
    minIntervalMs,
    maxScopeIds,
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const timer = { fn, fireAt: nowMs + ms, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (t) => { if (t) t.cancelled = true; },
  });
  return {
    sent,
    scheduler,
    advanceToFireAll() {
      // 依次执行所有到期定时器（新定时器可能在执行中产生，循环直到无到期项）
      for (;;) {
        timers.sort((a, b) => a.fireAt - b.fireAt);
        const next = timers.find((t) => !t.fired && !t.cancelled && t.fireAt <= nowMs);
        if (!next) break;
        next.fired = true;
        next.fn();
      }
    },
    tick(ms) { nowMs += ms; this.advanceToFireAll(); },
  };
}

test('窗口内多次请求合并为一次广播，payload 携带合并 scope', () => {
  const h = createHarness();
  h.scheduler.request({ reason: 'conversations:changed', conversationId: 'c-1' });
  h.scheduler.request({ reason: 'goalPlans:changed', planId: 'p-1' });
  h.scheduler.request({ reason: 'goalPlans:changed', planId: 'p-2' });
  h.tick(0); // 冷路径首个请求 schedule(0)，立即到期
  h.advanceToFireAll();

  assert.equal(h.sent.length, 1, '三次请求应只产生一次广播');
  const { channel, payload } = h.sent[0];
  assert.equal(channel, 'taskOverview:changed');
  assert.equal(payload.scoped, true);
  assert.deepEqual(new Set(payload.reasons), new Set(['conversations:changed', 'goalPlans:changed']));
  assert.deepEqual(new Set(payload.planIds), new Set(['p-1', 'p-2']));
  assert.deepEqual(new Set(payload.conversationIds), new Set(['c-1']));
});

test('最小间隔内的后续请求不触发第二次广播（节流）', () => {
  const h = createHarness({ minIntervalMs: 2000 });
  h.scheduler.request({ reason: 'conversations:changed' });
  h.tick(1); // 发出第一次（schedule(0) 立即到期）
  assert.equal(h.sent.length, 1);

  h.scheduler.request({ reason: 'goalPlans:changed' }); // 距上次 < 2s，进入窗口
  h.scheduler.request({ reason: 'goalPlans:changed' }); // 再来一次
  h.tick(1999);
  assert.equal(h.sent.length, 1, '窗口内不应广播');

  h.tick(1); // 到达 2s 边界，trailing 发出
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].payload.reasons, ['goalPlans:changed']);
});

test('风暴退化为全量 scope：ids 超限时 scoped=false 且列表清空', () => {
  const h = createHarness({ maxScopeIds: 3 });
  h.scheduler.request({ reason: 'conversations:changed', conversationId: 'c-1' });
  h.scheduler.request({ reason: 'conversations:changed', conversationId: 'c-2' });
  h.scheduler.request({ reason: 'conversations:changed', conversationId: 'c-3' });
  h.tick(0);
  h.advanceToFireAll();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].payload.scoped, true, '恰好 3 个未超限（>max 才退化）');

  const h2 = createHarness({ maxScopeIds: 3 });
  for (let i = 1; i <= 4; i++) {
    h2.scheduler.request({ reason: 'conversations:changed', conversationId: `c-${i}` });
  }
  h2.tick(0);
  h2.advanceToFireAll();
  assert.equal(h2.sent.length, 1);
  assert.equal(h2.sent[0].payload.scoped, false, '第 4 个 id 超限应退化为全量');
  assert.deepEqual(h2.sent[0].payload.planIds, []);
  assert.deepEqual(h2.sent[0].payload.conversationIds, []);
});

test('flush 同步发出挂起广播；dispose 后停止调度', () => {
  const h = createHarness();
  h.scheduler.request({ reason: 'goalPlans:changed', planId: 'p-9' });
  h.scheduler.flush();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].payload.planIds, ['p-9']);

  h.scheduler.dispose();
  h.scheduler.request({ reason: 'goalPlans:changed' });
  h.tick(5000);
  assert.equal(h.sent.length, 1, 'dispose 后不再广播');
});

test('300ms 风暴模拟：7.2s 内广播次数 ≤ 5（旧实现为 ~24 次）', () => {
  const h = createHarness({ minIntervalMs: 2000 });
  for (let t = 0; t <= 7200; t += 300) {
    h.scheduler.request({ reason: 'conversations:changed', conversationId: `c-${t}` });
    h.tick(300);
  }
  h.scheduler.flush();
  assert.ok(h.sent.length <= 5, `广播次数应 ≤5，实际 ${h.sent.length}`);
});
