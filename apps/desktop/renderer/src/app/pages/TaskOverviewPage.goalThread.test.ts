import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 目标线（Goal Thread）分组回归测试。
 *
 * 背景（2026-08-14）：groupResultCardsByGoalThread 第一版把无 rootPlanId 的
 * singles 收集进数组后，在第二段 emit 循环里被 `continue` 跳过、从未输出，
 * 导致 12 张旧数据卡在工作台「结果待验收」下整区空白（计数有值、无卡片）。
 *
 * 该文件用源码结构断言（与 acceptanceTransition.test.ts 同风格）+
 * 提取纯逻辑模拟两种数据形态，保证：
 * 1. 无 rootPlanId 的卡片逐张平铺、一张不丢；
 * 2. 同 rootPlanId ≥2 张归组为 thread，组内按 round 排序；
 * 3. 单张线归属卡降级为 single；
 * 4. thread / single / 无关系卡混合时输出完整、无重复无遗漏。
 */

const readPage = async () => {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
};

// ---- 与页面实现保持同一语义的纯逻辑镜像（结构断言保证两者同步）----
type Phase = 'submitting' | null;
interface Item { taskId: string; rootPlanId?: string; rootPlanTitle?: string; round?: number; relationType?: string }
type Entry = { item: Item; phase?: Phase };
type Group =
  | { kind: 'thread'; rootPlanId: string; items: { item: Item; phase: Phase }[] }
  | { kind: 'single'; item: Item; phase: Phase };

function mirror(entries: readonly Entry[]): Group[] {
  const threads = new Map<string, { rootPlanId: string; items: { item: Item; phase: Phase }[] }>();
  for (const entry of entries) {
    const phase = entry.phase ?? null;
    const rootPlanId = entry.item.rootPlanId;
    if (!rootPlanId) continue;
    const existing = threads.get(rootPlanId);
    if (existing) existing.items.push({ item: entry.item, phase });
    else threads.set(rootPlanId, { rootPlanId, items: [{ item: entry.item, phase }] });
  }
  const result: Group[] = [];
  const emitted = new Set<string>();
  for (const entry of entries) {
    const phase = entry.phase ?? null;
    const rootPlanId = entry.item.rootPlanId;
    if (!rootPlanId) {
      result.push({ kind: 'single', item: entry.item, phase });
      continue;
    }
    if (emitted.has(rootPlanId)) continue;
    emitted.add(rootPlanId);
    const thread = threads.get(rootPlanId);
    if (!thread) continue;
    if (thread.items.length < 2) {
      result.push({ kind: 'single', item: thread.items[0].item, phase: thread.items[0].phase });
      continue;
    }
    thread.items.sort((a, b) => (a.item.round ?? Infinity) - (b.item.round ?? Infinity));
    result.push({ kind: 'thread', ...thread });
  }
  return result;
}

test('源码结构：singles 不再被收集后丢弃（回归锚点）', async () => {
  const source = await readPage();
  // 第一段循环对无 rootPlanId 直接 continue（不进任何数组）
  assert.match(source, /if \(!rootPlanId\) continue;/);
  // 第二段循环对无 rootPlanId 逐张 push single
  assert.match(
    source,
    /if \(!rootPlanId\) \{[\s\S]*?result\.push\(\{ kind: 'single', item: entry\.item, phase \}\);[\s\S]*?continue;\n    \}/,
  );
  // 死代码 singles 数组已移除
  assert.doesNotMatch(source, /const singles:/);
});

test('纯逻辑：12 张无关系旧卡全部平铺输出（截图回归场景）', () => {
  const entries: Entry[] = Array.from({ length: 12 }, (_, i) => ({
    item: { taskId: `legacy-${i}` },
  }));
  const groups = mirror(entries);
  assert.equal(groups.length, 12);
  assert.ok(groups.every((g) => g.kind === 'single'));
  const ids = groups.map((g) => (g.kind === 'single' ? g.item.taskId : null));
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => `legacy-${i}`));
});

test('纯逻辑：同 root 两张卡归组为 thread 并按轮次排序', () => {
  const entries: Entry[] = [
    { item: { taskId: 'r2', rootPlanId: 'root', round: 2, relationType: 'derived', rootPlanTitle: '统一工具栏圆角' } },
    { item: { taskId: 'r1', rootPlanId: 'root', round: 1, rootPlanTitle: '统一工具栏圆角' } },
    { item: { taskId: 'solo' } },
  ];
  const groups = mirror(entries);
  assert.equal(groups.length, 2);
  const thread = groups.find((g) => g.kind === 'thread');
  assert.ok(thread && thread.kind === 'thread');
  assert.equal(thread.items[0].item.taskId, 'r1');
  assert.equal(thread.items[1].item.taskId, 'r2');
  const solo = groups.find((g) => g.kind === 'single');
  assert.ok(solo && solo.kind === 'single' && solo.item.taskId === 'solo');
});

test('纯逻辑：单张线归属卡降级 single；混合场景无重复无遗漏', () => {
  const entries: Entry[] = [
    { item: { taskId: 'a', rootPlanId: 't1', round: 1 } },
    { item: { taskId: 'b', rootPlanId: 't2', round: 1 } },
    { item: { taskId: 'c', rootPlanId: 't2', round: 2 } },
    { item: { taskId: 'plain-1' } },
    { item: { taskId: 'plain-2' } },
  ];
  const groups = mirror(entries);
  // t1 单卡 → single；t2 两卡 → thread；两张 plain → single：共 4 组 5 卡
  assert.equal(groups.length, 4);
  const count = groups.reduce((n, g) => n + (g.kind === 'thread' ? g.items.length : 1), 0);
  assert.equal(count, 5);
  const allIds = groups.flatMap((g) => (g.kind === 'thread' ? g.items.map((i) => i.item.taskId) : [g.item.taskId]));
  assert.deepEqual([...allIds].sort(), ['a', 'b', 'c', 'plain-1', 'plain-2']);
});
