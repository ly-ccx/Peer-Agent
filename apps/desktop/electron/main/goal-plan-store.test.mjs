import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGoalPlanStore, aggregateProgress } from './goal-plan-store.mjs';

let tmpRoot;
let store;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'goal-plan-'));
  process.env.PEER_AGENT_HOME = path.join(tmpRoot, '.peer-agent');
  store = createGoalPlanStore();
});

afterEach(() => {
  delete process.env.PEER_AGENT_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function draftWithTasks() {
  return {
    title: '重构鉴权',
    goal: '把鉴权抽到独立模块',
    successCriteria: ['所有测试通过'],
    tasks: [
      { taskId: 't1', order: 0, title: '抽接口', status: 'pending', evidenceRefs: [] },
      {
        taskId: 't2',
        order: 1,
        title: '迁移实现',
        status: 'pending',
        evidenceRefs: [],
        subtasks: [
          { taskId: 't2a', order: 0, title: '迁移 A', status: 'pending', evidenceRefs: [] },
          { taskId: 't2b', order: 1, title: '迁移 B', status: 'pending', evidenceRefs: [] },
        ],
      },
    ],
  };
}

test('aggregateProgress 只统计叶子任务（父任务不计数）', () => {
  const { tasks } = draftWithTasks();
  const p = aggregateProgress(tasks);
  // 叶子 = t1, t2a, t2b → total 3，父任务 t2 不计入
  assert.equal(p.total, 3);
  assert.equal(p.completed, 0);
  assert.equal(p.percent, 0);
});

test('createPlan 落盘并派生 progress，默认 drafting/version=1', () => {
  const plan = store.createPlan(draftWithTasks());
  assert.equal(plan.status, 'drafting');
  assert.equal(plan.version, 1);
  assert.equal(plan.progress.total, 3);
  // 列表与详情可读回
  assert.equal(store.listPlans().length, 1);
  const got = store.getPlan(plan.planId);
  assert.equal(got.title, '重构鉴权');
  assert.equal(got.progress.total, 3);
});

test('listPlanDetails 返回完整计划而不是轻量 index meta', () => {
  const plan = store.createPlan({ ...draftWithTasks(), conversationId: 1 });
  const metas = store.listPlansByConversation(1);
  assert.equal(metas.length, 1);
  assert.equal(metas[0].percent, 0);
  assert.equal(metas[0].progress, undefined);

  const details = store.listPlanDetailsByConversation(1);
  assert.equal(details.length, 1);
  assert.equal(details[0].planId, plan.planId);
  assert.equal(details[0].progress.percent, 0);
  assert.equal(details[0].tasks.length, 2);
});

test('recordTaskEvidence: completed 必须带 evidenceRefs，否则抛错', () => {
  const plan = store.createPlan(draftWithTasks());
  assert.throws(
    () => store.recordTaskEvidence(plan.planId, 't1', { status: 'completed' }),
    /without evidenceRefs/,
  );
});

test('recordTaskEvidence: 带 evidence 完成叶子任务后进度自底向上聚合', () => {
  const plan = store.createPlan(draftWithTasks());
  const r1 = store.recordTaskEvidence(plan.planId, 't1', {
    status: 'completed',
    evidenceRefs: ['local-shell-artifact://x/stdout'],
    result: 'done',
  });
  assert.equal(r1.progress.completed, 1);
  assert.equal(r1.progress.total, 3);
  assert.equal(r1.progress.percent, 33);

  // 完成一个嵌套叶子
  const r2 = store.recordTaskEvidence(plan.planId, 't2a', {
    status: 'completed',
    evidenceRefs: ['ev://2a'],
  });
  assert.equal(r2.progress.completed, 2);
  assert.equal(r2.progress.percent, 67);
});

test('recordTaskEvidence: failed / blocked 分别计数且写入原因', () => {
  const plan = store.createPlan(draftWithTasks());
  const rf = store.recordTaskEvidence(plan.planId, 't1', {
    status: 'failed',
    failureReason: '依赖缺失',
  });
  assert.equal(rf.progress.failed, 1);

  const rb = store.recordTaskEvidence(plan.planId, 't2b', {
    status: 'waiting_user',
    blockedReason: '等用户确认',
  });
  assert.equal(rb.progress.blocked, 1);
});

test('recordTaskEvidence: 未知 taskId 抛错', () => {
  const plan = store.createPlan(draftWithTasks());
  assert.throws(
    () => store.recordTaskEvidence(plan.planId, 'nope', { status: 'running' }),
    /not found/,
  );
});

test('revisePlan 递增 version 并追加 revisionHistory，progress 重算', () => {
  const plan = store.createPlan(draftWithTasks());
  const revised = store.revisePlan(
    plan.planId,
    { title: '重构鉴权 v2', tasks: [{ taskId: 'x', order: 0, title: '单任务', status: 'pending', evidenceRefs: [] }] },
    { reason: '缩小范围', changedBy: 'user' },
  );
  assert.equal(revised.version, 2);
  assert.equal(revised.title, '重构鉴权 v2');
  assert.equal(revised.revisionHistory.length, 1);
  assert.equal(revised.revisionHistory[0].reason, '缩小范围');
  assert.equal(revised.progress.total, 1);
});

test('revisePlan 忽略外部传入的 progress（不可手填）', () => {
  const plan = store.createPlan(draftWithTasks());
  const revised = store.revisePlan(plan.planId, {
    progress: { total: 999, completed: 999, failed: 0, blocked: 0, percent: 100 },
  });
  // 仍按真实 tasks 聚合
  assert.equal(revised.progress.total, 3);
  assert.equal(revised.progress.percent, 0);
});

test('recordApproval: approve → approved，并落批准 Evidence', () => {
  const plan = store.createPlan(draftWithTasks());
  const approved = store.recordApproval(plan.planId, {
    decision: 'approve',
    decidedBy: 'user',
    feedback: 'LGTM',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approval.decision, 'approve');
  assert.ok(approved.approval.confirmationId);
  assert.ok(approved.approval.decidedAt);
});

test('recordApproval: reject/revise 回到 drafting', () => {
  const plan = store.createPlan(draftWithTasks());
  const rejected = store.recordApproval(plan.planId, { decision: 'reject', feedback: '范围太大' });
  assert.equal(rejected.status, 'drafting');
});

test('setPlanStatus 推进整体状态', () => {
  const plan = store.createPlan(draftWithTasks());
  store.recordApproval(plan.planId, { decision: 'approve' });
  const exec = store.setPlanStatus(plan.planId, 'executing');
  assert.equal(exec.status, 'executing');
});

test('deletePlan 移除索引与文件', () => {
  const plan = store.createPlan(draftWithTasks());
  assert.equal(store.listPlans().length, 1);
  const rest = store.deletePlan(plan.planId);
  assert.equal(rest.length, 0);
  assert.equal(store.getPlan(plan.planId), null);
});

test('listPlansByConversation 按会话过滤', () => {
  store.createPlan({ ...draftWithTasks(), conversationId: 1 });
  store.createPlan({ ...draftWithTasks(), conversationId: 2 });
  assert.equal(store.listPlansByConversation(1).length, 1);
  assert.equal(store.listPlansByConversation(2).length, 1);
});
