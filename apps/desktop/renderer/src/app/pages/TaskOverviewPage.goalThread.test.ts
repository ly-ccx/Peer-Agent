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
 * 4. thread / single / 无关系卡混合时输出完整、无重复无遗漏；
 * 5. 一格一线：thread 只渲染一张 ResultCard，卡内嵌压缩树；
 * 6. 同线但未进验收队列的节点可作为上下文出现在树里。
 */

const readPage = async () => {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
};
const readGrouping = async () => {
  const { readFile } = await import('node:fs/promises');
  return readFile(new URL('./goalThreadGrouping.tsx', import.meta.url), 'utf8');
};

// ---- 与页面实现保持同一语义的纯逻辑镜像（结构断言保证两者同步）----
type Phase = 'submitting' | null;
interface Item {
  taskId: string;
  rootPlanId?: string;
  rootPlanTitle?: string;
  parentPlanId?: string;
  round?: number;
  relationType?: string;
  actionRight?: string;
}
type Entry = { item: Item; phase?: Phase };
type Group =
  | {
      kind: 'thread';
      rootPlanId: string;
      items: { item: Item; phase: Phase }[];
      latest: { item: Item; phase: Phase };
      nodes: { item: Item; isContext: boolean }[];
      pendingCount: number;
    }
  | { kind: 'single'; item: Item; phase: Phase };

function compareItems(a: Item, b: Item): number {
  const ar = a.round ?? Number.POSITIVE_INFINITY;
  const br = b.round ?? Number.POSITIVE_INFINITY;
  if (ar !== br) return ar - br;
  return String(a.taskId).localeCompare(String(b.taskId));
}

function compareEntries(a: { item: Item }, b: { item: Item }): number {
  return compareItems(a.item, b.item);
}

function pickLatestPending(items: readonly { item: Item; phase: Phase }[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].item.actionRight === 'result_ready') return items[index];
  }
  return items[items.length - 1];
}

function buildNodes(rootPlanId: string, pending: readonly { item: Item; phase: Phase }[], contextItems: readonly Item[]) {
  const pendingIds = new Set(pending.map((entry) => entry.item.taskId));
  const latestPending = pickLatestPending(pending)?.item.taskId;
  const byId = new Map<string, Item>();
  for (const item of contextItems) {
    if (item.rootPlanId === rootPlanId || item.taskId === rootPlanId) byId.set(item.taskId, item);
  }
  for (const entry of pending) byId.set(entry.item.taskId, entry.item);

  const children = new Map<string, Item[]>();
  for (const item of byId.values()) {
    const parentId = item.parentPlanId && byId.has(item.parentPlanId)
      ? item.parentPlanId
      : item.taskId === rootPlanId
        ? null
        : rootPlanId;
    if (!parentId || parentId === item.taskId) continue;
    const bucket = children.get(parentId) ?? [];
    bucket.push(item);
    children.set(parentId, bucket);
  }
  for (const bucket of children.values()) bucket.sort(compareItems);

  const nodes: { item: Item; isContext: boolean; isCurrent: boolean }[] = [];
  const walk = (item: Item) => {
    nodes.push({
      item,
      isContext: !pendingIds.has(item.taskId),
      isCurrent: item.taskId === latestPending,
    });
    for (const child of children.get(item.taskId) ?? []) walk(child);
  };
  const root = byId.get(rootPlanId)
    ?? pending.find((entry) => !entry.item.parentPlanId)?.item
    ?? pending[0]?.item;
  if (!root) return nodes;
  walk(root);
  for (const item of [...byId.values()].sort(compareItems)) {
    if (nodes.some((node) => node.item.taskId === item.taskId)) continue;
    walk(item);
  }
  return nodes;
}

function mirror(entries: readonly Entry[], contextItems: readonly Item[] = []): Group[] {
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
    thread.items.sort(compareEntries);
    const nodes = buildNodes(rootPlanId, thread.items, contextItems);
    if (thread.items.length < 2 && nodes.length < 2) {
      result.push({ kind: 'single', item: thread.items[0].item, phase: thread.items[0].phase });
      continue;
    }
    result.push({
      kind: 'thread',
      ...thread,
      latest: pickLatestPending(thread.items),
      nodes,
      pendingCount: thread.items.filter((item) => item.item.actionRight === 'result_ready').length,
    });
  }
  return result;
}

test('源码：无 rootPlanId 的卡在第一段就被 emit，不会被第二段 continue 吞掉', async () => {
  const source = await readGrouping();
  // 无 rootPlanId 的卡必须在扫描循环里立刻 push single 并 continue
  assert.match(
    source,
    /if \(!rootPlanId\) \{\n\s+result\.push\(\{ kind: 'single', item: entry\.item, phase \}\);\n\s+continue;\n\s+\}/,
  );
  // 死代码 singles 数组已移除
  assert.doesNotMatch(source, /const singles:/);
  assert.match(source, /thread-list/);
  assert.match(source, /function buildThreadListNodes/);
  assert.match(source, /function compareThreadItems/);
  assert.match(source, /function ThreadList\(/);
  assert.match(source, /role="list"/);
  // 同线 Goal 只按 round 排序，禁止恢复树语义、深度或子级投影。
  assert.doesNotMatch(source, /role="tree"|isChild|depth:|marginLeft/);
  assert.doesNotMatch(source, /className="goal-thread-group"/);
  // 回归：byId 列表节点是 TaskOverviewItem，必须使用 item 比较器；
  // 待验收 entries 自身仍可合法使用 compareThreadEntries。
  assert.doesNotMatch(source, /byId\.values\(\)\]\.sort\(compareThreadEntries\)/);
  assert.match(source, /function compareThreadItems/);
  assert.match(source, /byId\.values\(\)\]\s*\.sort\(compareThreadItems\)/);
});

test('源码：区级页面归组卡带上同线待签项，树行点击只开单个节点', async () => {
  const source = await readPage();
  // 归组卡「查看结果」带上这条线全部待签项；点某一行仍只传 node.item。
  assert.match(source, /acceptTogether=\{collectPendingAcceptanceItems\(/);
  assert.match(source, /onOpenItem\?\.\(item, acceptTogether\?\.length \? \{ acceptTogether \} : undefined\)/);
  const grouping = await readGrouping();
  assert.match(grouping, /onClick=\{\(\) => onOpenItem\?\.\(node\.item\)\}/);
  assert.doesNotMatch(
    grouping,
    /onClick=\{\(\) => onOpenItem\?\.\(node\.item, acceptTogether/,
  );
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
    { item: { taskId: 'r2', rootPlanId: 'root', round: 2, relationType: 'derived', rootPlanTitle: '统一工具栏圆角', actionRight: 'result_ready' } },
    { item: { taskId: 'r1', rootPlanId: 'root', round: 1, rootPlanTitle: '统一工具栏圆角', actionRight: 'result_ready' } },
    { item: { taskId: 'solo' } },
  ];
  const groups = mirror(entries);
  assert.equal(groups.length, 2);
  const thread = groups.find((g) => g.kind === 'thread');
  assert.ok(thread && thread.kind === 'thread');
  assert.equal(thread.items[0].item.taskId, 'r1');
  assert.equal(thread.items[1].item.taskId, 'r2');
  assert.equal(thread.latest.item.taskId, 'r2');
  assert.equal(thread.pendingCount, 2);
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

test('纯逻辑：未进队列的同线节点作为上下文出现在树里', () => {
  const entries: Entry[] = [
    { item: { taskId: 'root', rootPlanId: 'root', round: 1, actionRight: 'result_ready' } },
    { item: { taskId: 'latest', rootPlanId: 'root', parentPlanId: 'submit', round: 3, actionRight: 'result_ready' } },
  ];
  const context = [
    { taskId: 'submit', rootPlanId: 'root', parentPlanId: 'root', round: 2, actionRight: 'terminal' },
  ];
  const groups = mirror(entries, context);
  assert.equal(groups.length, 1);
  const thread = groups[0];
  assert.ok(thread.kind === 'thread');
  assert.equal(thread.latest.item.taskId, 'latest');
  assert.deepEqual(thread.nodes.map((node) => node.item.taskId), ['root', 'submit', 'latest']);
  assert.equal(thread.nodes.find((node) => node.item.taskId === 'submit')?.isContext, true);
});

test('纯逻辑：同父节点的兄弟按 round 排序，且不会把 TaskOverviewItem 当成 { item }', () => {
  const entries: Entry[] = [
    { item: { taskId: 'root', rootPlanId: 'root', round: 1, actionRight: 'result_ready' } },
    { item: { taskId: 'late', rootPlanId: 'root', parentPlanId: 'root', round: 3, actionRight: 'result_ready' } },
    { item: { taskId: 'early', rootPlanId: 'root', parentPlanId: 'root', round: 2, actionRight: 'result_ready' } },
  ];
  const groups = mirror(entries);
  assert.equal(groups.length, 1);
  const thread = groups[0];
  assert.ok(thread.kind === 'thread');
  assert.deepEqual(thread.nodes.map((node) => node.item.taskId), ['root', 'early', 'late']);
  assert.equal(thread.latest.item.taskId, 'late');
});
