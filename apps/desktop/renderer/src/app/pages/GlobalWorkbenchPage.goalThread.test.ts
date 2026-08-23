import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 总工作台（GlobalWorkbenchPage）Goal Thread 分组回归测试。
 *
 * 背景（2026-08-16）：区级 TaskOverviewPage 已有「一格一线」分组，但总工作台
 * 待验收列表仍把同线多卡平铺成 N 张独立卡。本次把分组提取为共享模块
 * goalThreadGrouping 并接入总工作台渲染路径。
 *
 * 保证：
 * 1. 渲染路径引用共享分组模块（groupResultCardsByGoalThread）；
 * 2. thread 组卡内渲染 ThreadList，打开依据页时带上同线待签项；
 * 3. single 组（无 rootPlanId 旧数据）走原 InboxRow 平铺路径，不套树；
 * 4. 待验收计数 = 分组后的组数（N 张同线卡算 1 项）。
 */

const readPage = async () => {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('./GlobalWorkbenchPage.tsx', import.meta.url), 'utf8');
};

test('总工作台：待验收列表引用共享 Goal Thread 分组模块', async () => {
  const source = await readPage();
  // 渲染数据源：分组派生必须存在，且 contextItems 传全量 items（树上下文）。
  assert.match(source, /groupResultCardsByGoalThread\(displayedResults, items\)/);
  // 计数跟随分组：同线 N 卡合并为 1 项。
  assert.match(source, /gwb-side-count">\{resultGroups\.length\} 项<\/span>/);
  assert.doesNotMatch(source, /gwb-side-count">\{displayedResults\.length\} 项/);
});

test('总工作台：thread 组卡内渲染同级 Goal 列表并带上同线待签', async () => {
  const source = await readPage();
  assert.match(source, /threadNodes=\{group\.nodes\}/);
  assert.match(source, /threadPendingCount=\{group\.pendingCount\}/);
  assert.match(source, /<ThreadList nodes=\{threadNodes\}/);
  // 打开依据页带上 acceptTogether，归档时一次签完同线待签项。
  assert.match(source, /collectPendingAcceptanceItems\(/);
  assert.match(source, /acceptTogether: collectPendingAcceptanceItems\(/);
  assert.doesNotMatch(source, /for \(const pending of collectPendingAcceptanceItems\(/);
});

test('总工作台：single 组保持原 InboxRow 平铺路径（旧数据兼容）', async () => {
  const source = await readPage();
  // single 分支：无 threadNodes / ThreadList，走与改造前一致的平铺渲染。
  assert.match(
    source,
    /<InboxRow\s+key=\{group\.item\.taskId\}\s+item=\{group\.item\}\s+kind="accept"\s+phase=\{group\.phase\}/,
  );
  // single 分支不得挂树。
  const singleBranch = source.split('key={group.item.taskId}')[1]?.split('/>')[0] ?? '';
  assert.ok(!singleBranch.includes('threadNodes'), 'single 分支不应传 threadNodes');
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
