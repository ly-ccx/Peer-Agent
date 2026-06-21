import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGoalPlanStore, aggregateProgress, derivePlanStatus } from './goal-plan-store.mjs';

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

test('derivePlanStatus: 执行前(awaiting_approval/approved)有活跃子任务 → executing', () => {
  const running = [{ taskId: 't1', status: 'running' }];
  assert.equal(derivePlanStatus('awaiting_approval', running), 'executing');
  assert.equal(derivePlanStatus('approved', running), 'executing');
  // 终态/阻塞也视为已开始执行
  assert.equal(derivePlanStatus('awaiting_approval', [{ status: 'completed' }]), 'executing');
  assert.equal(derivePlanStatus('awaiting_approval', [{ status: 'failed' }]), 'executing');
  assert.equal(derivePlanStatus('awaiting_approval', [{ status: 'waiting_user' }]), 'executing');
});

test('derivePlanStatus: 嵌套子任务里有活跃叶子也能识别为已开始', () => {
  const nested = [
    { taskId: 't1', status: 'pending' },
    { taskId: 't2', status: 'pending', subtasks: [{ taskId: 't2a', status: 'running' }] },
  ];
  assert.equal(derivePlanStatus('awaiting_approval', nested), 'executing');
});

test('derivePlanStatus: 全部 pending 时保持原状态（不前进）', () => {
  const pending = [{ taskId: 't1', status: 'pending' }];
  assert.equal(derivePlanStatus('awaiting_approval', pending), 'awaiting_approval');
  assert.equal(derivePlanStatus('approved', pending), 'approved');
});

test('derivePlanStatus: 只前进，不干扰其它显式状态机', () => {
  const running = [{ taskId: 't1', status: 'running' }];
  // drafting/executing/completed/cancelled/paused 等都原样返回
  assert.equal(derivePlanStatus('drafting', running), 'drafting');
  assert.equal(derivePlanStatus('executing', running), 'executing');
  assert.equal(derivePlanStatus('completed', running), 'completed');
  assert.equal(derivePlanStatus('cancelled', running), 'cancelled');
});

test('derivePlanStatus: executing + 全叶子 completed → completed（自动收尾）', () => {
  const tasks = [
    { taskId: 't1', status: 'completed' },
    { taskId: 't2', status: 'completed' },
  ];
  assert.equal(derivePlanStatus('executing', tasks), 'completed');
});

test('derivePlanStatus: executing + 含 failed（其余 completed）→ failed', () => {
  const tasks = [
    { taskId: 't1', status: 'completed' },
    { taskId: 't2', status: 'failed' },
  ];
  assert.equal(derivePlanStatus('executing', tasks), 'failed');
});

test('derivePlanStatus: executing + 仍有 running/pending → 维持 executing（不前进）', () => {
  assert.equal(
    derivePlanStatus('executing', [
      { taskId: 't1', status: 'completed' },
      { taskId: 't2', status: 'running' },
    ]),
    'executing',
  );
  assert.equal(
    derivePlanStatus('executing', [
      { taskId: 't1', status: 'completed' },
      { taskId: 't2', status: 'pending' },
    ]),
    'executing',
  );
});

test('derivePlanStatus: executing + 含 waiting_user（阻塞）→ 维持 executing（不收尾）', () => {
  const tasks = [
    { taskId: 't1', status: 'completed' },
    { taskId: 't2', status: 'waiting_user' },
  ];
  assert.equal(derivePlanStatus('executing', tasks), 'executing');
});

test('derivePlanStatus: executing + 空叶子 → 不前进（维持 executing）', () => {
  assert.equal(derivePlanStatus('executing', []), 'executing');
});

test('derivePlanStatus: executing + 嵌套子树全终态 → 收尾（completed）', () => {
  const tasks = [
    { taskId: 't1', status: 'completed' },
    {
      taskId: 't2',
      status: 'running', // 父任务自身状态不计入，只看叶子
      subtasks: [
        { taskId: 't2a', status: 'completed' },
        { taskId: 't2b', status: 'completed' },
      ],
    },
  ];
  assert.equal(derivePlanStatus('executing', tasks), 'completed');
});

test('recordTaskEvidence: 最后一个子任务完成后，executing 计划自动收尾为 completed', () => {
  const created = store.createPlan(draftWithTasks());
  store.setPlanStatus(created.planId, 'executing');

  // 叶子 = t1, t2a, t2b；逐个完成
  store.recordTaskEvidence(created.planId, 't1', {
    status: 'completed',
    evidenceRefs: ['artifact://1'],
  });
  store.recordTaskEvidence(created.planId, 't2a', {
    status: 'completed',
    evidenceRefs: ['artifact://2'],
  });
  assert.equal(
    store.getPlan(created.planId).status,
    'executing',
    '尚有未完成叶子时维持 executing',
  );

  store.recordTaskEvidence(created.planId, 't2b', {
    status: 'completed',
    evidenceRefs: ['artifact://3'],
  });
  const after = store.getPlan(created.planId);
  assert.equal(after.status, 'completed', '全部叶子完成后应自动收尾为 completed');
  assert.equal(after.progress.percent, 100);
});

test('recordTaskEvidence: 对话直接触发执行时，awaiting_approval 计划自动推进为 executing（收起审批按钮）', () => {
  // 模拟 AI 路径：goal_create_plan 落盘后处于 awaiting_approval
  const created = store.createPlan(draftWithTasks());
  store.setPlanStatus(created.planId, 'awaiting_approval');
  assert.equal(store.getPlan(created.planId).status, 'awaiting_approval');

  // 用户在对话里直接触发执行：AI 调用 goal_update_task 把某子任务置 running
  store.recordTaskEvidence(created.planId, 't1', { status: 'running' });

  const after = store.getPlan(created.planId);
  assert.equal(after.status, 'executing', '有子任务 running 后计划应自动推进为 executing');
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

test('recordApproval: reject 取消计划并从活动列表隐藏', () => {
  const plan = store.createPlan(draftWithTasks());
  const rejected = store.recordApproval(plan.planId, { decision: 'reject', feedback: '范围太大' });
  assert.equal(rejected.status, 'cancelled');
  assert.equal(store.getPlan(plan.planId)?.status, 'cancelled');
  assert.equal(store.listPlans().length, 0);
  assert.equal(store.listPlanDetails().length, 0);
});

test('recordApproval: revise 回到 drafting', () => {
  const plan = store.createPlan(draftWithTasks());
  const revised = store.recordApproval(plan.planId, { decision: 'revise', feedback: '范围太大' });
  assert.equal(revised.status, 'drafting');
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

test('listPlansByConversation 按会话过滤，且空会话不退化为全量列表', () => {
  store.createPlan({ ...draftWithTasks(), conversationId: '1' });
  store.createPlan({ ...draftWithTasks(), conversationId: '2' });
  store.createPlan({ ...draftWithTasks(), conversationId: null });
  assert.equal(store.listPlansByConversation('1').length, 1);
  assert.equal(store.listPlansByConversation('2').length, 1);
  assert.equal(store.listPlansByConversation(null).length, 0);
  assert.equal(store.listPlanDetailsByConversation(undefined).length, 0);
});

test('onChange: 每个写操作（含 AI 工具路径的 create/recordTaskEvidence）都触发一次变更通知', () => {
  const events = [];
  const watched = createGoalPlanStore({ onChange: (e) => events.push(e) });

  const plan = watched.createPlan(draftWithTasks());
  assert.equal(events.length, 1, 'createPlan 应触发一次');
  assert.equal(events[0].reason, 'persist');
  assert.equal(events[0].planId, plan.planId);

  watched.recordTaskEvidence(plan.planId, 't1', {
    status: 'completed',
    evidenceRefs: ['artifact://x'],
  });
  assert.equal(events.length, 2, 'recordTaskEvidence 应再触发一次');

  watched.recordApproval(plan.planId, { decision: 'approve' });
  watched.setPlanStatus(plan.planId, 'executing');
  watched.revisePlan(plan.planId, { goal: '新目标' });
  assert.equal(events.length, 5, 'approve/setStatus/revise 各触发一次');

  watched.deletePlan(plan.planId);
  assert.equal(events.length, 6, 'deletePlan 也应触发');
  assert.equal(events[5].reason, 'delete');
  assert.equal(events[5].planId, plan.planId);
});

test('onChange: 回调抛错不影响写盘事实（Evidence 已落盘）', () => {
  const watched = createGoalPlanStore({
    onChange: () => {
      throw new Error('listener boom');
    },
  });
  // 不应抛出；计划仍然成功落盘可读回
  const plan = watched.createPlan(draftWithTasks());
  assert.equal(watched.getPlan(plan.planId)?.title, '重构鉴权');
});

test('onChange: 不传回调时所有写操作正常（向后兼容）', () => {
  const plan = store.createPlan(draftWithTasks());
  assert.equal(store.getPlan(plan.planId)?.version, 1);
});

// ---- deletePlanByConversation：删除会话级联硬删除计划（见 ADR 34） ----

test('deletePlanByConversation: 只删目标会话的计划，其他会话/未关联计划保留', () => {
  const a1 = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  const a2 = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  const b1 = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-B' });
  const orphan = store.createPlan({ ...draftWithTasks(), conversationId: null });

  const remaining = store.deletePlanByConversation('conv-A');

  // conv-A 的两个计划被删，conv-B 与未关联计划保留
  const remainingIds = remaining.map((m) => m.planId).sort();
  assert.deepEqual(remainingIds, [b1.planId, orphan.planId].sort());
  assert.equal(store.getPlan(a1.planId), null);
  assert.equal(store.getPlan(a2.planId), null);
  assert.equal(store.getPlan(b1.planId)?.planId, b1.planId);
  assert.equal(store.getPlan(orphan.planId)?.planId, orphan.planId);
  assert.equal(store.listPlansByConversation('conv-A').length, 0);
  assert.equal(store.listPlansByConversation('conv-B').length, 1);
});

test('deletePlanByConversation: 计划文件被 unlink、索引行被移除', () => {
  const storeDir = path.join(tmpRoot, 'goal-plans-store');
  const s = createGoalPlanStore({ storeDir });
  const a1 = s.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  const b1 = s.createPlan({ ...draftWithTasks(), conversationId: 'conv-B' });

  // 删除前两个计划文件都在
  assert.equal(existsSync(path.join(storeDir, `${a1.planId}.json`)), true);
  assert.equal(existsSync(path.join(storeDir, `${b1.planId}.json`)), true);

  s.deletePlanByConversation('conv-A');

  // conv-A 的文件被 unlink，conv-B 的文件仍在
  assert.equal(existsSync(path.join(storeDir, `${a1.planId}.json`)), false);
  assert.equal(existsSync(path.join(storeDir, `${b1.planId}.json`)), true);
  // 索引里不再有 a1
  assert.equal(s.getPlan(a1.planId), null);
  assert.equal(s.listPlans().some((m) => m.planId === a1.planId), false);
});

test('deletePlanByConversation: 空/null 会话 id 是 no-op，绝不误删未关联会话的计划', () => {
  const orphan1 = store.createPlan({ ...draftWithTasks(), conversationId: null });
  const orphan2 = store.createPlan({ ...draftWithTasks() }); // 不带 conversationId
  const linked = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });

  // null / undefined / 空白串都应 no-op，不删任何计划
  assert.equal(store.deletePlanByConversation(null).length, 3);
  assert.equal(store.deletePlanByConversation(undefined).length, 3);
  assert.equal(store.deletePlanByConversation('   ').length, 3);

  assert.equal(store.getPlan(orphan1.planId)?.planId, orphan1.planId);
  assert.equal(store.getPlan(orphan2.planId)?.planId, orphan2.planId);
  assert.equal(store.getPlan(linked.planId)?.planId, linked.planId);
});

test('deletePlanByConversation: 没有任何计划匹配的会话 id 是 no-op', () => {
  const a1 = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  const remaining = store.deletePlanByConversation('conv-NOPE');
  assert.equal(remaining.length, 1);
  assert.equal(store.getPlan(a1.planId)?.planId, a1.planId);
});

test('deletePlanByConversation: 批量删除只广播一次 onChange（reason=delete）', () => {
  const events = [];
  const watched = createGoalPlanStore({ onChange: (e) => events.push(e) });
  watched.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  watched.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  watched.createPlan({ ...draftWithTasks(), conversationId: 'conv-B' });
  const before = events.length;

  watched.deletePlanByConversation('conv-A');

  // 删了 2 个计划，但只广播一次
  assert.equal(events.length, before + 1, '批量级联删除应只广播一次');
  assert.equal(events[events.length - 1].reason, 'delete');
});

test('deletePlanByConversation: no-op 时不广播 onChange', () => {
  const events = [];
  const watched = createGoalPlanStore({ onChange: (e) => events.push(e) });
  watched.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  const before = events.length;

  watched.deletePlanByConversation(null); // no-op
  watched.deletePlanByConversation('conv-NOPE'); // 无匹配 no-op

  assert.equal(events.length, before, 'no-op 不应广播');
});

test('单活跃草稿: 同会话二次 createPlan 时旧 awaiting_approval 草稿被作废为 cancelled', () => {
  const first = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  // 把首个计划推进到 awaiting_approval（模拟提交审批但用户改方案另起新计划）
  store.setPlanStatus(first.planId, 'awaiting_approval');
  assert.equal(store.getPlan(first.planId)?.status, 'awaiting_approval');

  const second = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });

  // 旧草稿被作废
  const firstAfter = store.getPlan(first.planId);
  assert.equal(firstAfter?.status, 'cancelled');
  // 审计：revisionHistory 追加了一条 supersede 记录
  const lastRev = firstAfter.revisionHistory[firstAfter.revisionHistory.length - 1];
  assert.equal(lastRev.changedBy, 'system:supersede');
  // 新计划不受影响，且作废后从活跃会话列表中排除，仅剩新计划
  assert.equal(store.getPlan(second.planId)?.status, 'drafting');
  const active = store.listPlansByConversation('conv-A');
  assert.equal(active.length, 1);
  assert.equal(active[0].planId, second.planId);
});

test('单活跃草稿: 仅作废 awaiting_approval，drafting/executing 旧计划不受影响', () => {
  const draftingOld = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  const executingOld = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  store.setPlanStatus(executingOld.planId, 'executing');

  store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });

  // drafting 与 executing 旧计划都不应被作废
  assert.equal(store.getPlan(draftingOld.planId)?.status, 'drafting');
  assert.equal(store.getPlan(executingOld.planId)?.status, 'executing');
});

test('单活跃草稿: 跨会话不互相作废', () => {
  const convA = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  store.setPlanStatus(convA.planId, 'awaiting_approval');

  // 另一个会话新建计划，不应影响 conv-A 的待批准草稿
  store.createPlan({ ...draftWithTasks(), conversationId: 'conv-B' });

  assert.equal(store.getPlan(convA.planId)?.status, 'awaiting_approval');
});

test('单活跃草稿: 无 conversationId 的草稿互不作废（绝不按 null===null 误伤）', () => {
  const orphan1 = store.createPlan({ ...draftWithTasks() }); // 无 conversationId
  store.setPlanStatus(orphan1.planId, 'awaiting_approval');

  const orphan2 = store.createPlan({ ...draftWithTasks() }); // 无 conversationId

  // 两个未关联会话的草稿应互不影响
  assert.equal(store.getPlan(orphan1.planId)?.status, 'awaiting_approval');
  assert.equal(store.getPlan(orphan2.planId)?.status, 'drafting');
});
