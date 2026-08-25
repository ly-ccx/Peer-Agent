import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createGoalPlanStore } from './goal-plan-store.mjs';

function createTempStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'goal-plan-title-'));
  const store = createGoalPlanStore({ storeDir: dir });
  return { dir, store };
}

test('createPlan: rejects raw utterance / long goal fallback as title', () => {
  const { dir, store } = createTempStore();
  try {
    const raw = '这种标题，不应该根据用户第一次对话的内容命名吧，应该分析了之后自动更新成用户的主要意图';
    const plan = store.createPlan({
      title: raw,
      goal: raw,
      tasks: [{ taskId: 'orient', title: '起步' }],
    });
    assert.equal(plan.title, '未命名任务');
    assert.notEqual(plan.title, raw);
    assert.ok(!plan.title.includes('不应该根据用户第一次'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createPlan: keeps short intent title', () => {
  const { dir, store } = createTempStore();
  try {
    const plan = store.createPlan({
      title: '优化计划意图标题',
      goal: '计划标题不再用用户首句原话；创建后可自动刷新。',
      tasks: [{ taskId: 'orient', title: '起步' }],
    });
    assert.equal(plan.title, '优化计划意图标题');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revisePlan: can refresh placeholder title, but blank/raw cannot overwrite good title', () => {
  const { dir, store } = createTempStore();
  try {
    const plan = store.createPlan({
      title: '',
      goal: '这种标题，不应该根据用户第一次对话的内容命名吧',
      tasks: [{ taskId: 'orient', title: '起步' }],
    });
    assert.equal(plan.title, '未命名任务');

    const refreshed = store.revisePlan(plan.planId, { title: '优化计划意图标题' }, {
      reason: 'intent clarified',
      changedBy: 'agent',
    });
    assert.equal(refreshed.title, '优化计划意图标题');

    const kept = store.revisePlan(plan.planId, {
      title: '这种标题，不应该根据用户第一次对话的内容命名吧，应该分析了之后自动更新成用户的主要意图',
    }, {
      reason: 'bad title should not overwrite',
      changedBy: 'agent',
    });
    assert.equal(kept.title, '优化计划意图标题');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
