import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { GoalPlan } from '@peer-agent/protocol';
import { goalActivity } from './goalActivity.ts';

for (const parent of ['running', 'paused', 'failed', 'blocked', 'completed', 'cancelled']) {
  for (const child of ['queued', 'running', 'completed', 'failed']) {
    for (const isZh of [true, false]) {
      test(`${parent} × ${child} × ${isZh ? 'zh' : 'en'}`, () => {
        const plan = {
          status: 'executing', tasks: [],
          runner: { enabled: true, status: parent, phase: 'explore', explorers: [{ status: child }] },
        } as unknown as GoalPlan;
        const result = goalActivity(plan, isZh);
        const expected = parent === 'running'
          ? ({ queued: ['排队中', 'queued'], running: ['后台调查', 'running'], completed: ['接续主任务', 'continuing'], failed: ['调查失败', 'Investigation failed'] }[child]!)
          : ({ paused: ['已暂停', 'paused'], failed: ['失败', 'failed'], blocked: ['需要你', 'attention'], completed: ['已结束', 'finished'], cancelled: ['已取消', 'cancelled'] }[parent]!);
        assert.ok(result.includes(expected[isZh ? 0 : 1]), result);
      });
    }
  }
}

test('conversation and sidebar use the same activity projection', () => {
  const source = readFileSync(new URL('../GoalPlanPanel.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('<GoalActivityLabel plan={activePlan} isZh={isZh} />'));
  assert.ok(source.includes('<GoalActivityLabel plan={plan} isZh={isZh} />'));
  assert.ok(source.indexOf('<RunnerSection') < source.indexOf('<RunTraceSection'));
  assert.ok(!source.includes("payload?.changeKind === 'runner-progress' || payload?.runner"), 'lifecycle events must reload the whole plan');
  const css = readFileSync(new URL('../../styles/goal-panel.css', import.meta.url), 'utf8');
  const summary = css.match(/\.goal-panel-toggle-summary\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.ok(summary.includes('white-space: nowrap'));
  assert.ok(!summary.includes('flex-direction: column'));
});

for (const isZh of [true, false]) {
  test(`interruption describes previous task run, not current conversation: ${isZh}`, () => {
    const plan = { status: 'interrupted', tasks: [], runner: { status: 'failed', enabled: true } } as unknown as GoalPlan;
    assert.equal(goalActivity(plan, isZh), isZh ? '上次任务执行中断' : 'Previous task run interrupted');
  });
}

for (const streaming of [true, false]) {
  for (const status of ['interrupted', 'paused', 'cancelled', 'completed']) {
    for (const isZh of [true, false]) {
      test(`conversation streaming ${streaming} × plan ${status} × locale ${isZh}`, () => {
        const plan = { status, tasks: [], runner: { enabled: true, status: 'failed' } } as unknown as GoalPlan;
        const before = JSON.stringify(plan);
        const label = goalActivity(plan, isZh, streaming);
        if (status === 'interrupted' && streaming) {
          assert.match(label, isZh ? /会话输出中/ : /Conversation streaming/);
          assert.match(label, isZh ? /中断记录/ : /interruption recorded/);
        } else {
          assert.equal(label, goalActivity(plan, isZh));
        }
        assert.equal(JSON.stringify(plan), before, 'streaming must never reactivate a plan');
      });
    }
  }
}

for (const oldStatus of ['queued', 'running', 'completed', 'failed']) {
  test(`old batch ${oldStatus} cannot replace current activity`, () => {
    const plan = {
      status: 'executing', tasks: [],
      runner: { enabled: true, status: 'running', phase: 'verify', explorerBatch: { batchId: 'new' },
        explorers: [{ batchId: 'old', status: oldStatus }] },
    } as unknown as GoalPlan;
    assert.equal(goalActivity(plan, true), '正在验证结果');
  });
}
