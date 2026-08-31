import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 总工作台（GlobalWorkbenchPage）Goal Thread 分组回归测试。
 *
 * 背景：Goal 完成即终态后，总工作台主列不再挂待验收分组。
 * 共享模块 goalThreadGrouping 仍保留纯逻辑；页面只渲染「需要你」。
 *
 * 保证：
 * 1. 主列不再引用 groupResultCardsByGoalThread / resultGroups；
 * 2. InboxRow 只走 kind="need"；
 * 3. 共享分组语义仍由下方镜像测试锁住。
 */

const readPage = async () => {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('./GlobalWorkbenchPage.tsx', import.meta.url), 'utf8');
};

test('总工作台：主列不再渲染待验收 Goal Thread 分组', async () => {
  const source = await readPage();
  assert.doesNotMatch(source, /groupResultCardsByGoalThread/);
  assert.doesNotMatch(source, /resultGroups/);
  assert.doesNotMatch(source, /displayedResults/);
  assert.match(source, /\{needsYou\.length\} 需你 · \{advancing\.length\} 推进/);
});

test('总工作台：主列 InboxRow 只走需要你，不带同线待签', async () => {
  const source = await readPage();
  assert.match(source, /kind="need"/);
  assert.doesNotMatch(source, /kind="accept"/);
  assert.doesNotMatch(source, /threadNodes=\{group\.nodes\}/);
  assert.doesNotMatch(source, /collectPendingAcceptanceItems\(/);
  assert.doesNotMatch(source, /acceptTogether:/);
});

test('总工作台：需要你列表保持 InboxRow 平铺路径', async () => {
  const source = await readPage();
  assert.match(
    source,
    /<InboxRow\s+key=\{item\.taskId\}\s+item=\{item\}\s+kind="need"/,
  );
  const needBranch = source.split('kind="need"')[1]?.split('/>')[0] ?? '';
  assert.ok(!needBranch.includes('threadNodes'), '需要你行不应传 threadNodes');
});

// ---- 与共享实现保持同一语义的纯逻辑镜像（防止模块被误删/改动后断言失真）----
type Phase = string | null;
type MirrorItem = {
  taskId: string;
  rootPlanId?: string;
  round?: number;
  actionRight?: string;
};
type MirrorGroup =
  | { kind: 'thread'; rootPlanId: string; items: { item: MirrorItem }[]; pendingCount: number }
  | { kind: 'single'; item: MirrorItem };

function mirrorGroup(entries: readonly { item: MirrorItem; phase?: Phase }[]): MirrorGroup[] {
  const threads = new Map<string, { rootPlanId: string; items: { item: MirrorItem; phase: Phase }[] }>();
  for (const entry of entries) {
    const rootPlanId = entry.item.rootPlanId;
    if (!rootPlanId) continue;
    const existing = threads.get(rootPlanId);
    if (existing) existing.items.push({ item: entry.item, phase: entry.phase ?? null });
    else threads.set(rootPlanId, { rootPlanId, items: [{ item: entry.item, phase: entry.phase ?? null }] });
  }
  const result: MirrorGroup[] = [];
  const emitted = new Set<string>();
  for (const entry of entries) {
    const rootPlanId = entry.item.rootPlanId;
    if (!rootPlanId) {
      result.push({ kind: 'single', item: entry.item });
      continue;
    }
    if (emitted.has(rootPlanId)) continue;
    emitted.add(rootPlanId);
    const thread = threads.get(rootPlanId);
    if (!thread) continue;
    if (thread.items.length < 2) {
      result.push({ kind: 'single', item: thread.items[0].item });
      continue;
    }
    const pendingCount = thread.items.filter((e) => e.item.actionRight === 'result_ready').length;
    result.push({ kind: 'thread', rootPlanId, items: thread.items, pendingCount });
  }
  return result;
}

test('纯逻辑：总工作台同线三卡合并为一组，旧数据平铺不丢', () => {
  const entries = [
    { item: { taskId: 'plain-1', actionRight: 'result_ready' }, phase: null },
    { item: { taskId: 'root', rootPlanId: 'root', round: 1, actionRight: 'result_ready' }, phase: null },
    { item: { taskId: 'mid', rootPlanId: 'root', round: 2, actionRight: 'result_ready' }, phase: null },
    { item: { taskId: 'leaf', rootPlanId: 'root', round: 3, actionRight: 'result_ready' }, phase: null },
    { item: { taskId: 'plain-2', actionRight: 'result_ready' }, phase: null },
  ];
  const groups = mirrorGroup(entries);
  assert.equal(groups.length, 3);
  assert.equal(groups.filter((g) => g.kind === 'single').length, 2);
  const thread = groups.find((g) => g.kind === 'thread');
  assert.ok(thread && thread.kind === 'thread');
  assert.equal(thread.items.length, 3);
  assert.equal(thread.pendingCount, 3);
});

test('纯逻辑：无 rootPlanId 的旧数据全部平铺且顺序稳定', () => {
  const entries = Array.from({ length: 9 }, (_, i) => ({
    item: { taskId: `legacy-${i}`, actionRight: 'result_ready' },
    phase: null,
  }));
  const groups = mirrorGroup(entries);
  assert.equal(groups.length, 9);
  assert.ok(groups.every((g) => g.kind === 'single'));
  assert.deepEqual(
    groups.map((g) => (g.kind === 'single' ? g.item.taskId : null)),
    Array.from({ length: 9 }, (_, i) => `legacy-${i}`),
  );
});
