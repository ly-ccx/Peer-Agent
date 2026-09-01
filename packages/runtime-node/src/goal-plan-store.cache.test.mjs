import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';

function createTempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'goal-plan-cache-'));
  const store = createGoalPlanStore({ storeDir: dir });
  return { dir, store };
}

test('listPlans 缓存命中：index 未变化时复用结果（不重复 normalize 全量索引）', async () => {
  const { dir, store } = createTempStore();
  try {
    store.createPlan({ title: 'plan-a', goal: 'cache-test' });
    const first = store.listPlans();
    assert.equal(first.length, 1);

    // 第二次调用应命中 mtime+size 缓存并返回等值结果；
    // 用 spy 思路验证：直接对比两次结果一致性 + 时间大幅缩短（粗验证）。
    const t0 = process.hrtime.bigint();
    const second = store.listPlans();
    const t1 = process.hrtime.bigint();
    assert.equal(second.length, 1);
    assert.equal(second[0].planId, first[0].planId);
    // 真正复用归一化结果对象；数组本身是浅拷贝，避免调用方 sort 污染缓存。
    assert.equal(second[0], first[0]);
    assert.notEqual(second, first);
    // 缓存命中路径只做 stat + 浅拷贝，应在个位数 ms 内。
    assert.ok(Number(t1 - t0) < 50_000_000, `second listPlans took ${Number(t1 - t0) / 1e6}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('缓存失效：外部写入 index.jsonl 后 listPlans 感知新数据', async () => {
  const { dir, store } = createTempStore();
  try {
    store.createPlan({ title: 'plan-a', goal: 'cache-test' });
    assert.equal(store.listPlans().length, 1);

    // 模拟外部进程写入：直接 append 一条合法 index 记录（mtime/size 均变化）。
    const indexFile = path.join(dir, 'index.jsonl');
    const existing = store.listPlans();
    const externalRecord = {
      ...existing[0],
      planId: 'external-plan-0001',
      title: 'external-plan',
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(indexFile, JSON.stringify(externalRecord) + '\n', { flag: 'a' });

    const after = store.listPlans();
    assert.equal(after.length, 2, '外部写入后应看到新 plan（缓存已失效）');
    assert.ok(after.some((p) => p.planId === 'external-plan-0001'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同进程 persist 后 listPlans 立即反映变更（writeJsonl 使缓存失效）', async () => {
  const { dir, store } = createTempStore();
  try {
    store.createPlan({ title: 'plan-a', goal: 'cache-test' });
    store.createPlan({ title: 'plan-b', goal: 'cache-test' });
    // persist 走 writeJsonl（重写整个 index.jsonl），随后读取必须看到两条。
    assert.equal(store.listPlans().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
