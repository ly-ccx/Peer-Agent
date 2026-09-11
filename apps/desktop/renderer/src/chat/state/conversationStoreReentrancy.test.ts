import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConversationStore } from './conversationStore.ts';
import { setStreamProfilingEnabled } from './streamProfiler.ts';

/** 每个用例用独立 store，避免单例互相污染。 */
function createStore() {
  return new ConversationStore();
}

describe('conversationStore equal-value writes', () => {
  it('treats a rebuilt-but-equal array as no change (the loop-breaker)', () => {
    const store = createStore();
    const call = { id: 'a' } as never;
    let notifications = 0;
    store.subscribe('eq1', () => {
      notifications += 1;
    });

    // 空态本身就是 []：写 [] 属于「等值」→ 不通知。
    // 这正是 setPendingPermissionCalls([]) 这类写法不能再驱动循环的原因。
    store.setState('eq1', { pendingPermissionCalls: [] });
    assert.equal(notifications, 0, 'writing [] onto the empty state is a no-op');

    store.setState('eq1', { pendingPermissionCalls: [call] });
    assert.equal(notifications, 1, 'a real change still notifies');

    // 内容相同、引用不同：绝不能触发通知。
    store.setState('eq1', { pendingPermissionCalls: [call] });
    assert.equal(notifications, 1, 'equal-value rebuild must not notify');
  });

  it('still notifies when the array content really changes', () => {
    const store = createStore();
    const call = { id: 'a' } as never;
    let notifications = 0;
    store.subscribe('eq2', () => {
      notifications += 1;
    });

    store.setState('eq2', { pendingPermissionCalls: [] });
    assert.equal(notifications, 0, 'empty onto empty is a no-op');
    store.setState('eq2', { pendingPermissionCalls: [call] });
    assert.equal(notifications, 1, 'adding an entry is a real change');
    store.setState('eq2', { pendingPermissionCalls: [] });
    assert.equal(notifications, 2, 'removing an entry is a real change');
  });

  it('treats a copy of the same elements as no change', () => {
    const store = createStore();
    const a = { id: 'a' } as never;
    const b = { id: 'b' } as never;
    store.setState('eq3', { pendingPermissionCalls: [a, b] });

    let notifications = 0;
    store.subscribe('eq3', () => {
      notifications += 1;
    });
    // [...same] 同一个元素引用：内容未变，不应通知。
    store.setState('eq3', { pendingPermissionCalls: [a, b] });
    assert.equal(notifications, 0, 'shallow-equal copy must not notify');
  });

  it('keeps detecting streaming appends (new tail object still counts)', () => {
    // 关键回归护栏：append 会构造新的末尾消息对象，因此浅比较仍然判定为变化。
    // 若这里退化为「不通知」，流式内容就会停止刷新。
    const store = createStore();
    const first = { role: 'assistant', segments: [] } as never;
    store.setState('eq4', { messages: [first] });

    let notifications = 0;
    store.subscribe('eq4', () => {
      notifications += 1;
    });
    const appended = { role: 'assistant', segments: [] } as never;
    store.setState('eq4', { messages: [appended] });
    assert.equal(notifications, 1, 'a new tail object must still notify');

    // 同一对象引用重复写入 → 不通知（幂等）。
    store.setState('eq4', { messages: [appended] });
    assert.equal(notifications, 1);
  });

  it('still notifies on scalar changes', () => {
    const store = createStore();
    let notifications = 0;
    store.subscribe('eq5', () => {
      notifications += 1;
    });
    store.setState('eq5', { draft: 'a' });
    store.setState('eq5', { draft: 'a' });
    store.setState('eq5', { draft: 'b' });
    assert.equal(notifications, 2, 'same value is a no-op, new value notifies');
  });

  it('breaks a self-feeding effect-style loop that rewrites an equal array', async () => {
    // 复刻报错机制：某个 effect 每次运行都写一个「等值新数组」。
    // 改前：每次都通知 → 重渲染 → effect 再跑 → React 抛 Maximum update depth exceeded。
    // 改后：从第二次起判定为无变化，循环自然终止。
    const store = createStore();
    const call = { id: 'a' } as never;
    // 先建立非空基线，让第一次回写[]成为真实变化，从而真的能启动循环。
    store.setState('loop', { pendingPermissionCalls: [call] });

    let runs = 0;
    let notifications = 0;
    store.subscribe('loop', () => {
      notifications += 1;
      if (runs >= 5) return; // 防御：万一修复失效，也不让用例自身无限跑
      runs += 1;
      store.setState('loop', { pendingPermissionCalls: [] });
    });

    store.setState('loop', { pendingPermissionCalls: [] });
    for (let i = 0; i < 10; i += 1) {
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    }

    // 循环必须收敛：第二次写 [] 起内容不再变化，也就不再通知。
    assert.ok(runs <= 2, `loop must converge immediately, but ran ${runs} times`);
    assert.ok(notifications <= 3, `notifications must be bounded, got ${notifications}`);
  });
});

describe('conversationStore notify re-entrancy', () => {
  it('does not recurse when a listener writes to the store again', () => {
    const store = createStore();
    const seen: string[] = [];
    let wroteNested = false;

    store.subscribe('c1', () => {
      seen.push('notify');
      if (wroteNested) return;
      wroteNested = true;
      // 订阅者在通知回调里回写 store——这正是把 React 嵌套更新推爆的写法。
      store.setState('c1', { draft: 'nested' });
    });

    store.setState('c1', { draft: 'outer' });

    // 关键断言：回写没有在同一调用栈里递归通知（递归通知 → React 嵌套更新 → 崩溃）。
    assert.deepEqual(seen, ['notify'], 'nested write must not notify synchronously');
    // 内层写入本身必须已经生效（不能因为保护而丢写）。
    assert.equal(store.getSnapshot('c1').draft, 'nested');
  });

  it('still delivers the deferred notification on a later microtask', async () => {
    const store = createStore();
    const seen: string[] = [];
    let wroteNested = false;

    store.subscribe('c2', () => {
      seen.push('notify');
      if (wroteNested) return;
      wroteNested = true;
      store.setState('c2', { draft: 'nested' });
    });

    store.setState('c2', { draft: 'outer' });
    assert.equal(seen.length, 1);

    // 补发发生在微任务里：通知不丢，只是不再嵌进渲染阶段。
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    assert.equal(seen.length, 2, 'deferred notification must still be delivered');
  });

  it('keeps the plain (non-reentrant) path fully synchronous', () => {
    const store = createStore();
    const seen: string[] = [];

    store.subscribe('c3', () => seen.push('a'));
    store.subscribe('c3', () => seen.push('b'));

    store.setState('c3', { draft: 'x' });

    // 无重入时不应有任何延迟：两个订阅者都在同一次调用里被通知。
    assert.deepEqual(seen, ['a', 'b']);
  });

  it('does not notify listeners of untouched buckets', () => {
    const store = createStore();
    const seen: string[] = [];

    store.subscribe('c4', () => seen.push('c4'));
    store.subscribe('c5', () => seen.push('c5'));

    store.setState('c4', { draft: 'x' });
    assert.deepEqual(seen, ['c4']);
  });

  it('converges instead of looping when listeners write on every notification', async () => {
    const store = createStore();
    let notifications = 0;

    // 每次收到通知都回写：最坏形态。没有保护时这里会持续递归直到 React 崩溃。
    store.subscribe('c6', () => {
      notifications += 1;
      store.setState('c6', { draft: `n${notifications}` });
    });

    store.setState('c6', { draft: 'n0' });
    // 排空微任务队列，观察是否收敛（而非无限补发）。
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));
    }

    // 必须有限：补发轮数有上限，不会无限增长。
    assert.ok(notifications > 1, 'self-writing listener should still get re-notified');
    assert.ok(notifications <= 32, `notifications must be bounded, got ${notifications}`);
  });
});

describe('notify storm detector', () => {
  /** 捕获 console.warn，跑完恢复原样。 */
  function captureWarnings(run: () => void): string[] {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      run();
    } finally {
      console.warn = original;
    }
    return warnings;
  }

  it('detects a storm without requiring any profiler setup (the whole point)', () => {
    // 这条契约是刻意从「关闭时静默」改过来的：定位本 bug 需要用户复现一次，
    // 而要求用户先开开关已经失败过一次。改用零配置检测，代价只是每次通知一次时钟比较。
    setStreamProfilingEnabled(false);
    const store = createStore();
    const warnings = captureWarnings(() => {
      for (let i = 0; i < 60; i += 1) store.setState('s1', { draft: `d${i}` });
    });
    assert.equal(warnings.length, 1, `expected one zero-config storm report, got ${warnings.length}`);
    assert.match(warnings[0], /疑似更新循环/);
  });

  it('reports one stack trace when a single bucket is notified in a tight burst', () => {
    setStreamProfilingEnabled(true);
    const store = createStore();
    try {
      const warnings = captureWarnings(() => {
        for (let i = 0; i < 40; i += 1) store.setState('s2', { draft: `d${i}` });
      });
      assert.equal(warnings.length, 1, `expected exactly one storm report, got ${warnings.length}`);
      assert.match(warnings[0], /notify storm|疑似更新循环/);
      // 关键：报告里必须带「写入方」的帧，这正是定位循环源所需的证据。
      assert.match(warnings[0], /conversationStore|notify|setState/);
    } finally {
      setStreamProfilingEnabled(false);
    }
  });

  it('does not spam: a quiet bucket never triggers a report', () => {
    // 稀疏写入（真实流式节流后约 4 次/秒）绝不能误报成风暴。
    setStreamProfilingEnabled(false);
    const store = createStore();
    const warnings = captureWarnings(() => {
      for (let i = 0; i < 5; i += 1) store.setState('s3', { draft: `d${i}` });
    });
    assert.deepEqual(warnings, [], 'a handful of writes must not be treated as a storm');
  });
});
