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

// 创建并批准一个计划，返回已批准（approved）的计划。
// 批准闸门（见 goal-plan-store recordTaskEvidence 的 Layer B 护栏与
// derivePlanStatus 规则 1）要求：只有 approved 之后，子任务才能进入执行态
// （running / completed / failed / waiting_user）。凡是需要把任务标成执行态的
// 测试，都应先经过本辅助批准，模拟真实的「先批准、再开工」调用路径。
function approvedPlanWithTasks() {
  const plan = store.createPlan(draftWithTasks());
  store.recordApproval(plan.planId, { decision: 'approve' });
  return store.getPlan(plan.planId);
}

function registerEvidenceRefsFor(targetStore, planId, refs) {
  const plan = targetStore.getPlan(planId);
  return targetStore.recordEvidenceRefs({
    planId,
    conversationId: plan?.conversationId,
    streamId: 'test-stream',
    toolCallId: `test-${String(planId).slice(0, 8)}`,
    toolName: 'test_evidence_source',
    evidenceRefs: refs,
    artifactRefs: refs,
  });
}

function registerEvidenceRefs(planId, refs) {
  return registerEvidenceRefsFor(store, planId, refs);
}

test('aggregateProgress 只统计叶子任务（父任务不计数）', () => {
  const { tasks } = draftWithTasks();
  const p = aggregateProgress(tasks);
  // 叶子 = t1, t2a, t2b → total 3，父任务 t2 不计入
  assert.equal(p.total, 3);
  assert.equal(p.completed, 0);
  assert.equal(p.percent, 0);
});

test('derivePlanStatus: 已批准(approved)有活跃子任务 → executing', () => {
  const running = [{ taskId: 't1', status: 'running' }];
  assert.equal(derivePlanStatus('approved', running), 'executing');
  // 终态/阻塞也视为已开始执行
  assert.equal(derivePlanStatus('approved', [{ status: 'completed' }]), 'executing');
  assert.equal(derivePlanStatus('approved', [{ status: 'failed' }]), 'executing');
  assert.equal(derivePlanStatus('approved', [{ status: 'waiting_user' }]), 'executing');
});

test('derivePlanStatus: 未批准(awaiting_approval)即便有活跃子任务也不推进为 executing', () => {
  // 批准闸门：未批准计划不允许被派生成 executing，避免「顶层 executing 但从未批准、
  // Runner 未启动」的僵死态。真实链路里，任务能进入 running 之前必先经 recordApproval。
  const running = [{ taskId: 't1', status: 'running' }];
  assert.equal(derivePlanStatus('awaiting_approval', running), 'awaiting_approval');
  assert.equal(derivePlanStatus('awaiting_approval', [{ status: 'completed' }]), 'awaiting_approval');
  assert.equal(derivePlanStatus('awaiting_approval', [{ status: 'failed' }]), 'awaiting_approval');
  assert.equal(
    derivePlanStatus('awaiting_approval', [{ status: 'waiting_user' }]),
    'awaiting_approval',
  );
});

test('derivePlanStatus: 已批准计划嵌套子任务里有活跃叶子也能识别为已开始', () => {
  const nested = [
    { taskId: 't1', status: 'pending' },
    { taskId: 't2', status: 'pending', subtasks: [{ taskId: 't2a', status: 'running' }] },
  ];
  assert.equal(derivePlanStatus('approved', nested), 'executing');
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

test('appendRunEvent persists Goal / Plan / Run trace events without changing task progress', () => {
  const plan = store.createGoalContract({
    conversationId: 'conv-run-trace',
    title: '网关开关与 AK 退场',
    goal: '网关开关与 AK 退场',
  });
  assert.equal(plan.runTrace.events.length, 1);
  assert.equal(plan.runTrace.events[0].type, 'goal_created');

  const updated = store.appendRunEvent(plan.planId, {
    type: 'goal_resumed',
    summary: 'User resumed the current Goal: 继续',
    payload: {
      intent: 'resume',
      messageText: '继续',
    },
  });

  assert.equal(updated.planId, plan.planId);
  assert.equal(updated.progress.total, plan.progress.total);
  assert.equal(updated.progress.completed, plan.progress.completed);
  assert.equal(updated.runTrace.events.length, 2);
  const resumeEvent = updated.runTrace.events[1];
  assert.equal(resumeEvent.type, 'goal_resumed');
  assert.equal(resumeEvent.payload.intent, 'resume');

  const reloaded = store.getPlan(plan.planId);
  assert.equal(reloaded.runTrace.events.length, 2);
  assert.equal(reloaded.runTrace.events[1].summary, 'User resumed the current Goal: 继续');
});

test('createPlan and revisePlan record plan lifecycle run trace events', () => {
  const plan = store.createPlan(draftWithTasks());
  assert.equal(plan.runTrace.events.length, 1);
  assert.equal(plan.runTrace.events[0].type, 'plan_created');
  assert.equal(plan.runTrace.events[0].payload.taskCount, 2);

  const revised = store.revisePlan(plan.planId, {
    title: 'revised plan',
  }, {
    reason: 'dynamic replanning',
    changedBy: 'agent',
  });
  assert.equal(revised.runTrace.events.length, 2);
  assert.equal(revised.runTrace.events[1].type, 'plan_revised');
  assert.equal(revised.runTrace.events[1].payload.version, 2);
});

test('appendRunEvent records checkpoint resume coordinates when a node is supplied', () => {
  const plan = store.createGoalContract({
    conversationId: 'conv-checkpoint',
    title: '恢复点测试',
    goal: '恢复点测试',
  });

  const updated = store.appendRunEvent(plan.planId, {
    type: 'checkpoint_created',
    nodeId: 'node-verify-agent-binding',
    summary: '恢复点：正在验证 agent binding 分支',
  });

  assert.equal(updated.runTrace.activeNodeId, 'node-verify-agent-binding');
  assert.equal(updated.runTrace.lastCheckpointNodeId, 'node-verify-agent-binding');
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
  registerEvidenceRefs(created.planId, ['artifact://1', 'artifact://2', 'artifact://3']);
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

test('recordTaskEvidence: 未批准计划把子任务标 running 被护栏拒绝（批准闸门守在源头）', () => {
  // 模拟 AI 路径：goal_create_plan 落盘后处于 awaiting_approval
  const created = store.createPlan(draftWithTasks());
  store.setPlanStatus(created.planId, 'awaiting_approval');
  assert.equal(store.getPlan(created.planId).status, 'awaiting_approval');

  // 未批准时 AI 想直接把子任务置 running → Layer B 护栏抛错，杜绝绕过审批开工。
  assert.throws(
    () => store.recordTaskEvidence(created.planId, 't1', { status: 'running' }),
    /before plan .* is approved/,
  );
  // 计划状态不被污染，仍停留在 awaiting_approval（未被派生成 executing）。
  assert.equal(store.getPlan(created.planId).status, 'awaiting_approval');
});

test('recordTaskEvidence: accepted 的自驱 Goal 不走 Plan 批准闸门，可由 Evidence 推进', () => {
  const created = store.createGoalContract({
    conversationId: 'conv-goal',
    title: '修复失败测试',
    goal: '定位并修复失败测试',
    tasks: [
      { taskId: 'g1', order: 0, title: '定位失败', status: 'pending', evidenceRefs: [] },
    ],
  });

  assert.equal(created.status, 'accepted');
  assert.equal(created.workflowKind, 'goal_self_driven');
  assert.equal(created.activation.kind, 'accepted_goal');
  assert.equal(created.approval, undefined);

  store.recordTaskEvidence(created.planId, 'g1', { status: 'running' });
  assert.equal(store.getPlan(created.planId).status, 'executing');

  registerEvidenceRefs(created.planId, ['local-test-artifact://goal-store']);
  store.recordTaskEvidence(created.planId, 'g1', {
    status: 'completed',
    evidenceRefs: ['local-test-artifact://goal-store'],
    result: '失败测试已修复',
  });

  const after = store.getPlan(created.planId);
  assert.equal(after.status, 'completed');
  assert.equal(after.progress.percent, 100);
  assert.deepEqual(after.tasks[0].evidenceRefs, ['local-test-artifact://goal-store']);
});

test('upsertGoalContract: 复用同会话自驱 Goal，且不把调用控制字段写入 artifact', () => {
  const first = store.upsertGoalContract('conv-upsert', {
    title: '初始目标',
    goal: '整理目标上下文',
    createdBy: 'user',
  });
  const second = store.upsertGoalContract('conv-upsert', {
    title: '更新目标',
    goal: '整理目标上下文并补验证',
    revisionReason: 'latest user goal message',
    changedBy: 'user',
    createdBy: 'agent',
  });

  assert.equal(second.planId, first.planId);
  assert.equal(second.version, 2);
  assert.equal(second.status, 'accepted');
  assert.equal(second.workflowKind, 'goal_self_driven');
  assert.equal(second.title, '更新目标');
  assert.equal(second.goal, '整理目标上下文并补验证');
  assert.equal(Object.hasOwn(second, 'revisionReason'), false);
  assert.equal(Object.hasOwn(second, 'changedBy'), false);
  assert.equal(second.createdBy, 'user');
  assert.equal(second.revisionHistory.at(-1).reason, 'latest user goal message');
  assert.equal(second.revisionHistory.at(-1).changedBy, 'user');

  const plans = store.listPlanDetailsByConversation('conv-upsert');
  assert.equal(plans.length, 1);
});

test('upsertGoalContract: 可在知识仓发起后绑定目标代码仓，且后续 upsert 不清空 target', () => {
  const originWorkspacePath = '/repo/peer-knowledge';
  const targetWorkspacePath = '/repo/peer_agent';
  const first = store.upsertGoalContract('conv-cross-workspace', {
    title: '修复 Goal 工作区绑定',
    goal: '从知识仓发起，落地到代码仓',
    originWorkspacePath,
    createdBy: 'user',
  });

  const bound = store.upsertGoalContract('conv-cross-workspace', {
    title: '实现跨仓 Goal 绑定',
    goal: '从知识仓读取上下文，在代码仓完成实现',
    targetWorkspacePath,
    createdBy: 'agent',
  });

  assert.equal(bound.planId, first.planId);
  assert.equal(bound.originWorkspacePath, originWorkspacePath);
  assert.equal(bound.targetWorkspacePath, targetWorkspacePath);

  const revised = store.upsertGoalContract('conv-cross-workspace', {
    title: '继续跨仓 Goal',
    goal: '继续推进同一个跨仓目标',
    originWorkspacePath,
    createdBy: 'user',
  });

  assert.equal(revised.planId, first.planId);
  assert.equal(revised.originWorkspacePath, originWorkspacePath);
  assert.equal(revised.targetWorkspacePath, targetWorkspacePath);
});

test('recordTaskEvidence: 批准后把子任务标 running，计划自动推进为 executing', () => {
  const created = approvedPlanWithTasks();
  assert.equal(created.status, 'approved');

  store.recordTaskEvidence(created.planId, 't1', { status: 'running' });

  const after = store.getPlan(created.planId);
  assert.equal(after.status, 'executing', '批准后有子任务 running，计划应自动推进为 executing');
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
  const plan = approvedPlanWithTasks();
  assert.throws(
    () => store.recordTaskEvidence(plan.planId, 't1', { status: 'completed' }),
    /without evidenceRefs/,
  );
});

test('recordTaskEvidence: completed 不能引用未登记的 EvidenceIndex ref', () => {
  const plan = approvedPlanWithTasks();
  assert.throws(
    () => store.recordTaskEvidence(plan.planId, 't1', {
      status: 'completed',
      evidenceRefs: ['artifact://forged'],
    }),
    /not registered in EvidenceIndex/,
  );
});

test('recordTaskEvidence: 带 evidence 完成叶子任务后进度自底向上聚合', () => {
  const plan = approvedPlanWithTasks();
  registerEvidenceRefs(plan.planId, ['local-shell-artifact://x/stdout', 'ev://2a']);
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
  const plan = approvedPlanWithTasks();
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
  const plan = approvedPlanWithTasks();
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

  // 批准闸门：必须先批准，子任务才能进入执行态并回写 evidence。
  watched.recordApproval(plan.planId, { decision: 'approve' });
  assert.equal(events.length, 2, 'approve 应再触发一次');

  registerEvidenceRefsFor(watched, plan.planId, ['artifact://x']);
  watched.recordTaskEvidence(plan.planId, 't1', {
    status: 'completed',
    evidenceRefs: ['artifact://x'],
  });
  assert.equal(events.length, 3, 'recordTaskEvidence 应再触发一次');

  watched.setPlanStatus(plan.planId, 'executing');
  watched.revisePlan(plan.planId, { goal: '新目标' });
  assert.equal(events.length, 5, 'setStatus/revise 各触发一次');

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

test('单活跃计划: executing 旧计划仍有未完成叶子时，新建计划令其作废为 cancelled(superseded)', () => {
  const executingOld = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  store.setPlanStatus(executingOld.planId, 'executing');
  // 只完成部分叶子（t1 完成，t2a/t2b 仍 pending）→ 存在未完成叶子，维持 executing
  registerEvidenceRefs(executingOld.planId, ['local-file://done-t1']);
  store.recordTaskEvidence(executingOld.planId, 't1', {
    status: 'completed',
    evidenceRefs: ['local-file://done-t1'],
  });
  assert.equal(store.getPlan(executingOld.planId)?.status, 'executing');

  store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });

  // 仍有未完成叶子 → 作废而非伪造完成
  const after = store.getPlan(executingOld.planId);
  assert.equal(after?.status, 'cancelled');
  const lastRev = after.revisionHistory[after.revisionHistory.length - 1];
  assert.equal(lastRev.changedBy, 'system:supersede');
});

test('单活跃计划: executing 旧计划全叶子终态时，新建计划令其如实收尾为 completed', () => {
  const executingOld = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  store.setPlanStatus(executingOld.planId, 'executing');
  // 把全部叶子（t1/t2a/t2b）置为终态 completed
  registerEvidenceRefs(executingOld.planId, ['local-file://done-t1', 'local-file://done-t2a', 'local-file://done-t2b']);
  for (const taskId of ['t1', 't2a', 't2b']) {
    store.recordTaskEvidence(executingOld.planId, taskId, {
      status: 'completed',
      evidenceRefs: [`local-file://done-${taskId}`],
    });
  }
  // 全叶子终态后，persist 的 derivePlanStatus 已把它收尾为 completed
  assert.equal(store.getPlan(executingOld.planId)?.status, 'completed');

  // 即便已是 completed（终态），新建计划也不应回退或误伤它
  store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  assert.equal(store.getPlan(executingOld.planId)?.status, 'completed');
});

test('单活跃计划: drafting 旧计划（无活跃叶子）被新建计划作废为 cancelled', () => {
  const draftingOld = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });
  assert.equal(store.getPlan(draftingOld.planId)?.status, 'drafting');

  store.createPlan({ ...draftWithTasks(), conversationId: 'conv-A' });

  // drafting 仍有未完成叶子 → 作废
  const after = store.getPlan(draftingOld.planId);
  assert.equal(after?.status, 'cancelled');
  const lastRev = after.revisionHistory[after.revisionHistory.length - 1];
  assert.equal(lastRev.changedBy, 'system:supersede');
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

test('runner: 旧 plan 缺少 runner 字段时仍可读取', () => {
  const plan = store.createPlan(draftWithTasks());
  const got = store.getPlan(plan.planId);
  assert.equal(got.runner, undefined);
});

test('runner: setRunnerState 可写入并读回 runner 状态', () => {
  const plan = store.createPlan(draftWithTasks());
  const updated = store.setRunnerState(plan.planId, {
    enabled: true,
    status: 'exploring',
    intent: 'explore',
    currentTaskId: 't1',
    turnCount: 2,
    toolCallCount: 3,
    explorerCount: 1,
    maxTurns: 12,
    maxToolCalls: 60,
    maxExplorers: 5,
    blockedReason: 'need more evidence',
    lastError: 'previous failure',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(updated.runner.enabled, true);
  assert.equal(updated.runner.status, 'exploring');
  assert.equal(updated.runner.intent, 'explore');
  assert.equal(updated.runner.currentTaskId, 't1');
  assert.equal(updated.runner.turnCount, 2);
  assert.equal(updated.runner.toolCallCount, 3);
  assert.equal(updated.runner.explorerCount, 1);
  assert.equal(updated.runner.maxTurns, 12);
  assert.equal(updated.runner.maxToolCalls, 60);
  assert.equal(updated.runner.maxExplorers, 5);
  assert.equal(updated.runner.blockedReason, 'need more evidence');
  assert.equal(updated.runner.lastError, 'previous failure');
  assert.equal(updated.runner.updatedAt, '2026-01-01T00:00:00.000Z');

  const got = store.getPlan(plan.planId);
  assert.deepEqual(got.runner, updated.runner);
});

test('runner: setRunnerState 归一化无效字段并补默认预算', () => {
  const plan = store.createPlan(draftWithTasks());
  const updated = store.setRunnerState(plan.planId, {
    enabled: true,
    status: 'unknown',
    intent: 'invalid',
    turnCount: -2,
    toolCallCount: 1.8,
    explorerCount: -3,
    maxTurns: 0,
    maxToolCalls: -10,
    maxExplorers: -1,
  });

  assert.equal(updated.runner.enabled, true);
  assert.equal(updated.runner.status, 'idle');
  assert.equal(updated.runner.intent, undefined);
  assert.equal(updated.runner.turnCount, 0);
  assert.equal(updated.runner.toolCallCount, 1);
  assert.equal(updated.runner.explorerCount, 0);
  assert.equal(updated.runner.maxTurns, 1);
  assert.equal(updated.runner.maxToolCalls, 1);
  assert.equal(updated.runner.maxExplorers, 0);
});

test('runner: maxExplorers 超过硬上限会被钳到上限（防失控派发）', () => {
  const plan = store.createPlan(draftWithTasks());
  const updated = store.setRunnerState(plan.planId, { enabled: true, maxExplorers: 9999 });
  // 上限为 10：超大值被钳住，正常值（≤10）原样保留。
  assert.equal(updated.runner.maxExplorers, 10);

  const within = store.setRunnerState(plan.planId, { enabled: true, maxExplorers: 5 });
  assert.equal(within.runner.maxExplorers, 5);
});

test('runner: setRunnerState 只更新 runner，不绕过 task Evidence 约束', () => {
  const plan = store.createPlan(draftWithTasks());
  const updated = store.setRunnerState(plan.planId, {
    enabled: true,
    status: 'running',
    currentTaskId: 't1',
    // 即使 patch 携带 plan/task 形态字段，也只能落进 runner 归一化白名单。
    tasks: [{ taskId: 't1', status: 'completed', evidenceRefs: [] }],
    evidenceRefs: ['fake-evidence'],
  });

  assert.equal(updated.tasks[0].status, 'pending');
  assert.deepEqual(updated.tasks[0].evidenceRefs, []);
  assert.deepEqual(updated.evidenceRefs, []);
  assert.equal(updated.runner.status, 'running');
});

test('runner: completed task 仍必须由 recordTaskEvidence 带 evidenceRefs 回写', () => {
  const plan = approvedPlanWithTasks();
  store.setRunnerState(plan.planId, { enabled: true, status: 'running', currentTaskId: 't1' });

  assert.throws(
    () => store.recordTaskEvidence(plan.planId, 't1', { status: 'completed' }),
    /cannot be 'completed' without evidenceRefs/,
  );
});

test('explorer: dispatch/report 动态记录子 Agent 实例且不改写任务状态', () => {
  const plan = store.createPlan(draftWithTasks());
  store.setRunnerState(plan.planId, { enabled: true, maxExplorers: 1 });

  const dispatched = store.dispatchExplorer(plan.planId, {
    question: '确认 store runner 字段',
    reason: '缺少本地证据',
    scope: { include: ['apps/desktop/electron/main/goal-plan-store.mjs'] },
    budget: { maxToolCalls: 4, maxDurationMs: 30000 },
  });

  assert.equal(dispatched.runner.status, 'exploring');
  assert.equal(dispatched.runner.intent, 'explore');
  assert.equal(dispatched.runner.explorerCount, 1);
  assert.equal(dispatched.runner.explorers[0].request.profile, 'readonly_explorer');
  assert.equal(dispatched.runner.explorers[0].request.question, '确认 store runner 字段');
  assert.equal(dispatched.tasks[0].status, 'pending');

  assert.throws(
    () => store.reportExplorer(plan.planId, dispatched.runner.explorers[0].explorerId, { summary: '缺证据' }),
    /cannot be 'completed' without evidenceRefs/,
  );

  const reported = store.reportExplorer(plan.planId, dispatched.runner.explorers[0].explorerId, {
    summary: '已确认 runner 字段',
    findings: [{ claim: 'runner 字段存在', evidenceRefs: ['tool-result://read-runner'] }],
    evidenceRefs: ['tool-result://read-runner'],
    allowedEvidenceRefs: ['tool-result://read-runner'],
    confidence: 'high',
  });

  assert.equal(reported.runner.status, 'idle');
  assert.equal(reported.runner.intent, 'verify');
  assert.equal(reported.runner.explorers[0].status, 'completed');
  assert.deepEqual(reported.runner.explorers[0].evidenceRefs, ['tool-result://read-runner']);
  assert.deepEqual(reported.runner.explorers[0].report.evidenceRefs, ['tool-result://read-runner']);
  assert.equal(reported.tasks[0].status, 'pending');
  assert.deepEqual(reported.evidenceRefs, []);
});

test('explorer: completed 报告只能引用本次 Explorer registry 中的 evidenceRefs', () => {
  const plan = store.createPlan(draftWithTasks());
  store.setRunnerState(plan.planId, { enabled: true });
  const dispatched = store.dispatchExplorer(plan.planId, {
    question: '确认证据索引',
    reason: '防止伪造 ref',
  });
  const explorerId = dispatched.runner.explorers[0].explorerId;

  assert.throws(
    () => store.reportExplorer(plan.planId, explorerId, {
      summary: '引用了未注册 ref',
      findings: [{ claim: 'x', evidenceRefs: ['tool-result://forged'] }],
      evidenceRefs: ['tool-result://forged'],
      allowedEvidenceRefs: ['tool-result://real'],
      confidence: 'high',
    }),
    /unregistered evidenceRefs: tool-result:\/\/forged/,
  );

  assert.throws(
    () => store.reportExplorer(plan.planId, explorerId, {
      summary: '没有 registry',
      findings: [{ claim: 'x', evidenceRefs: ['tool-result://real'] }],
      evidenceRefs: ['tool-result://real'],
      confidence: 'high',
    }),
    /without registered tool evidenceRefs/,
  );
});

test('explorer: dispatch 不再受累计上限限制（并发模型）', () => {
  const plan = store.createPlan(draftWithTasks());
  // maxExplorers 语义已弃用；即便设为 1，也不再对累计派发数设闸。
  store.setRunnerState(plan.planId, { enabled: true, maxExplorers: 1 });
  store.dispatchExplorer(plan.planId, { question: 'first', reason: 'test' });
  const after = store.dispatchExplorer(plan.planId, { question: 'second', reason: 'test' });
  // 第二次派发不再抛错，两个 explorer 都被登记。
  assert.equal(after.runner.explorers.length, 2);
  assert.equal(after.runner.explorerCount, 2);
});

test('explorer: 同一 batchId 的派发汇总为本轮进度 explorerBatch', () => {
  const plan = store.createPlan(draftWithTasks());
  store.setRunnerState(plan.planId, { enabled: true });
  const batchId = `${plan.planId}:t1`;
  store.dispatchExplorer(plan.planId, { question: 'a', reason: 'test', batchId });
  const dispatched = store.dispatchExplorer(plan.planId, { question: 'b', reason: 'test', batchId });
  // 本轮总数 2、已完成 0。
  assert.equal(dispatched.runner.explorerBatch.batchId, batchId);
  assert.equal(dispatched.runner.explorerBatch.total, 2);
  assert.equal(dispatched.runner.explorerBatch.done, 0);

  // 回填第一个 explorer 完成后，本轮进度 done 递增到 1。
  const firstId = dispatched.runner.explorers[0].explorerId;
  const reported = store.reportExplorer(plan.planId, firstId, {
    summary: 'done a',
    findings: [{ claim: 'x', evidenceRefs: ['tool-result://x'] }],
    evidenceRefs: ['tool-result://x'],
    allowedEvidenceRefs: ['tool-result://x'],
    confidence: 'high',
  });
  assert.equal(reported.runner.explorerBatch.total, 2);
  assert.equal(reported.runner.explorerBatch.done, 1);
});

test('explorer: explorerConcurrency 被钳制在硬上限 8 内', () => {
  const plan = store.createPlan(draftWithTasks());
  const over = store.setRunnerState(plan.planId, { enabled: true, explorerConcurrency: 50 });
  assert.equal(over.runner.explorerConcurrency, 8);
  const under = store.setRunnerState(plan.planId, { enabled: true, explorerConcurrency: 0 });
  // 至少为 1（并发池不可为 0）。
  assert.equal(under.runner.explorerConcurrency, 1);
});

test('verifier: recordVerifierRun 按 id upsert，且不替代 criterionResults', () => {
  const plan = store.createPlan({
    ...draftWithTasks(),
    successCriteria: [{ id: 'c1', kind: 'command', description: 'build', command: 'npm run build' }],
  });

  const running = store.recordVerifierRun(plan.planId, {
    verifierRunId: 'verifier-1',
    target: { kind: 'success_criterion', criterionId: 'c1' },
    status: 'running',
    summary: 'running build verification',
  });

  assert.equal(running.runner.verifierRuns.length, 1);
  assert.equal(running.runner.verifierRuns[0].status, 'running');
  assert.equal(running.runner.verifierRuns[0].target.criterionId, 'c1');
  assert.deepEqual(running.criterionResults, []);

  const passed = store.recordVerifierRun(plan.planId, {
    verifierRunId: 'verifier-1',
    target: { kind: 'success_criterion', criterionId: 'c1' },
    status: 'passed',
    evidenceRefs: ['tool-result://build'],
    summary: 'build passed',
  });

  assert.equal(passed.runner.verifierRuns.length, 1);
  assert.equal(passed.runner.verifierRuns[0].status, 'passed');
  assert.deepEqual(passed.runner.verifierRuns[0].evidenceRefs, ['tool-result://build']);
  assert.ok(passed.runner.verifierRuns[0].completedAt);
  // VerifierRun 是审计轨迹，不自动伪造 CriterionResult。
  assert.deepEqual(passed.criterionResults, []);
});

test('verifier: passed 必须带 evidenceRefs，且目标必须引用真实 task/criterion', () => {
  const plan = store.createPlan({
    ...draftWithTasks(),
    successCriteria: [{ id: 'c1', kind: 'test', description: 'tests', command: 'npm test' }],
  });

  assert.throws(
    () => store.recordVerifierRun(plan.planId, {
      target: { kind: 'success_criterion', criterionId: 'c1' },
      status: 'passed',
    }),
    /cannot be 'passed' without evidenceRefs/,
  );
  assert.throws(
    () => store.recordVerifierRun(plan.planId, {
      target: { kind: 'success_criterion', criterionId: 'missing' },
      status: 'running',
    }),
    /verifier target criterion missing not found/,
  );
  assert.throws(
    () => store.recordVerifierRun(plan.planId, {
      target: { kind: 'task', taskId: 'missing-task' },
      status: 'running',
    }),
    /verifier target task missing-task not found/,
  );
});

test('getActivePlanByConversation 返回同会话最新活跃计划，忽略结束态', () => {
  // 注意：同会话新建计划会触发 supersede 收尾旧活跃计划，因此这里只保留
  // 「一个活跃计划 + 一个已结束计划」的组合来验证「忽略结束态、返回活跃」。
  const done = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-active', title: 'done' });
  store.setPlanStatus(done.planId, 'cancelled');

  const active = store.createPlan({ ...draftWithTasks(), conversationId: 'conv-active', title: 'active' });
  store.setPlanStatus(active.planId, 'approved');

  const got = store.getActivePlanByConversation('conv-active');
  assert.equal(got.planId, active.planId);
  assert.equal(store.getActivePlanByConversation('missing'), null);
  assert.equal(store.getActivePlanByConversation(''), null);
});

// ===== DoD-as-Code：successCriteria 结构化 + 向后兼容 + criterionResults 回写 =====

test('successCriteria: 纯字符串向后兼容归一为 manual 结构化标准', () => {
  // draftWithTasks 用的是 ['所有测试通过'] 字符串形态（存量/口头 DoD）。
  const plan = store.createPlan(draftWithTasks());
  assert.equal(Array.isArray(plan.successCriteria), true);
  assert.equal(plan.successCriteria.length, 1);
  const c = plan.successCriteria[0];
  assert.equal(c.kind, 'manual');
  assert.equal(c.description, '所有测试通过');
  assert.ok(typeof c.id === 'string' && c.id.length > 0);
  // criterionResults 缺省归一为空数组。
  assert.deepEqual(plan.criterionResults, []);
});

test('successCriteria: 结构化对象保留 kind/command 等字段', () => {
  const plan = store.createPlan({
    ...draftWithTasks(),
    successCriteria: [
      { id: 'c1', kind: 'command', description: '跑单测', command: 'npm test' },
      { kind: 'file-exists', path: 'dist/index.js' },
      'ship it', // 混合字符串也接受
    ],
  });
  const [c1, c2, c3] = plan.successCriteria;
  assert.equal(c1.id, 'c1');
  assert.equal(c1.kind, 'command');
  assert.equal(c1.command, 'npm test');
  assert.equal(c2.kind, 'file-exists');
  assert.equal(c2.path, 'dist/index.js');
  assert.equal(c3.kind, 'manual');
  assert.equal(c3.description, 'ship it');
});

test('successCriteria: 非法 kind 归一为 manual', () => {
  const plan = store.createPlan({
    ...draftWithTasks(),
    successCriteria: [{ kind: 'bogus', description: '乱写的类型' }],
  });
  assert.equal(plan.successCriteria[0].kind, 'manual');
});

test('recordManualConfirmation: Manual DoD 确认落为独立治理事实', () => {
  const plan = store.createGoalContract({
    ...draftWithTasks(),
    successCriteria: [
      { id: 'manual-1', kind: 'manual', description: '用户确认体验达标' },
      { id: 'cmd-1', kind: 'command', description: '测试通过', command: 'npm test' },
    ],
  });

  const after = store.recordManualConfirmation(plan.planId, {
    confirmationId: 'confirm-1',
    kind: 'manual_dod',
    decision: 'approve',
    decidedBy: 'tester',
  });

  assert.equal(after.manualConfirmations.length, 1);
  assert.deepEqual(after.manualConfirmations[0], {
    confirmationId: 'confirm-1',
    kind: 'manual_dod',
    decision: 'approve',
    criterionIds: ['manual-1'],
    decidedBy: 'tester',
    decidedAt: after.manualConfirmations[0].decidedAt,
  });
  assert.equal(after.approval, undefined, 'Manual DoD 不能写成 Plan approval');
});

test('recordManualConfirmation: 只能确认计划内 manual successCriteria', () => {
  const plan = store.createGoalContract({
    ...draftWithTasks(),
    successCriteria: [
      { id: 'manual-1', kind: 'manual', description: '用户确认体验达标' },
      { id: 'cmd-1', kind: 'command', description: '测试通过', command: 'npm test' },
    ],
  });

  assert.throws(
    () => store.recordManualConfirmation(plan.planId, {
      kind: 'manual_dod',
      decision: 'approve',
      criterionIds: ['cmd-1'],
    }),
    /unknown manual criteria/,
  );
  assert.throws(
    () => store.recordManualConfirmation(plan.planId, {
      kind: 'manual_dod',
      decision: 'approve',
      criterionIds: ['missing'],
    }),
    /unknown manual criteria/,
  );
});

test('recordCriterionResults: 只接受已声明的 criterionId 并按 id 合并', () => {
  const plan = store.createPlan({
    ...draftWithTasks(),
    successCriteria: [
      { id: 'c1', kind: 'command', description: 'build', command: 'npm run build' },
      { id: 'c2', kind: 'test', description: 'tests', command: 'npm test' },
    ],
  });
  registerEvidenceRefs(plan.planId, ['ref://build', 'ref://test']);
  // 写入 c1 通过 + 一个未声明的 cX（应被忽略）。
  const after = store.recordCriterionResults(plan.planId, [
    { criterionId: 'c1', passed: true, evidenceRef: 'ref://build' },
    { criterionId: 'cX', passed: true, evidenceRef: 'ref://ghost' },
  ]);
  assert.equal(after.criterionResults.length, 1);
  assert.equal(after.criterionResults[0].criterionId, 'c1');
  assert.equal(after.criterionResults[0].passed, true);
  assert.equal(after.criterionResults[0].evidenceRef, 'ref://build');
  assert.ok(after.criterionResults[0].checkedAt);

  // 再写 c1（覆盖）+ c2（新增）。
  const after2 = store.recordCriterionResults(plan.planId, [
    { criterionId: 'c1', passed: false, detail: 'build broke' },
    { criterionId: 'c2', passed: true, evidenceRef: 'ref://test' },
  ]);
  const byId = Object.fromEntries(after2.criterionResults.map((r) => [r.criterionId, r]));
  assert.equal(after2.criterionResults.length, 2);
  assert.equal(byId.c1.passed, false);
  assert.equal(byId.c1.detail, 'build broke');
  assert.equal(byId.c2.passed, true);
  assert.equal(byId.c2.evidenceRef, 'ref://test');
});

test('recordCriterionResults: evidenceRef 必须来自 EvidenceIndex', () => {
  const plan = store.createPlan({
    ...draftWithTasks(),
    successCriteria: [
      { id: 'c1', kind: 'command', description: 'build', command: 'npm run build' },
    ],
  });
  assert.throws(
    () => store.recordCriterionResults(plan.planId, [
      { criterionId: 'c1', passed: true, evidenceRef: 'ref://forged' },
    ]),
    /not registered in EvidenceIndex/,
  );
});

test('recordCriterionResults: 计划不存在返回 null', () => {
  assert.equal(store.recordCriterionResults('missing', [{ criterionId: 'c1', passed: true }]), null);
});

test('normalizePlan 读路径：存量计划的字符串 successCriteria 读时被归一', () => {
  const plan = store.createPlan(draftWithTasks());
  // 重新读取（走 getPlan → normalizePlan）应拿到结构化形态。
  const reread = store.getPlan(plan.planId);
  assert.equal(reread.successCriteria[0].kind, 'manual');
  assert.equal(Array.isArray(reread.criterionResults), true);
});

// ── 方案乙：intake 判别契约（activation.kind='intake'）─────────────────────────

test('createIntakeContract: 建出的契约是 activation=intake 的自驱 goal（executing、可读回）', () => {
  const plan = store.createIntakeContract({
    conversationId: 'conv-intake-1',
    goal: '好了这个已经修复发布了，现在我想要知道我们现在的 ak 的管理机制',
    createdBy: 'user',
  });
  assert.equal(plan.activation.kind, 'intake');
  assert.equal(plan.workflowKind, 'goal_self_driven');
  assert.equal(plan.status, 'executing');
  // 归一化读回后仍保留 intake 授权类型。
  const reread = store.getPlan(plan.planId);
  assert.equal(reread.activation.kind, 'intake');
});

test('promoteIntakeToGoal: intake 契约就地升级为 accepted_goal（明确目标分支，不新建第二条）', () => {
  const intake = store.createIntakeContract({
    conversationId: 'conv-intake-2',
    goal: '把发布流程整理成文档',
  });
  const promoted = store.promoteIntakeToGoal(intake.planId, {
    goal: '把发布流程整理成一篇 SOP 文档并评审',
    title: '整理发布 SOP',
  });
  assert.equal(promoted.planId, intake.planId, '必须原地升级，planId 不变');
  assert.equal(promoted.activation.kind, 'accepted_goal');
  assert.equal(promoted.activation.intakeResolution, 'goal_confirmed');
  // 会话下仍只有一条契约（没有产生悬空的第二条）。
  const plans = store.listPlansByConversation('conv-intake-2');
  assert.equal(plans.length, 1);
});

test('upsertGoalContract: intake 轮调 goal_create_plan 命中当前 intake 契约并升级（A 方案信号）', () => {
  const intake = store.createIntakeContract({
    conversationId: 'conv-intake-3',
    goal: '模糊目标占位',
  });
  // 模型在 intake 轮调用 goal_create_plan → provider 走 upsertGoalContract。
  const upserted = store.upsertGoalContract('conv-intake-3', {
    goal: '给鉴权模块补齐单测',
    title: '补齐鉴权单测',
    activation: { kind: 'accepted_goal' },
  });
  assert.equal(upserted.planId, intake.planId, 'upsert 应命中当前 intake 契约而非新建');
  const plans = store.listPlansByConversation('conv-intake-3');
  assert.equal(plans.length, 1, '不应产生第二条悬空契约');
});
