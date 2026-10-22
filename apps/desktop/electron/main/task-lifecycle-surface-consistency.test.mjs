import assert from 'node:assert/strict';
import test from 'node:test';

import { decideLifecycle, projectGoalPlan, projectWorkSession } from '@peer-agent/protocol';

import { createTaskOverviewAggregator, toGoalPlanSnapshot } from './task-overview-aggregator.mjs';
// 真实渲染消费函数：UI 的取消入口只认决策给出的 cancelable，不自建第二套状态表。
import { canCancelTask } from '../../renderer/src/project-agent/state/botWorkState.ts';

const WORKSPACE = '/work/peer_agent';
const CONVERSATION_META = Object.freeze({
  workspaceId: 'workspace-peer-agent',
  sessionId: 'session-surface-consistency',
  origin: Object.freeze({}),
});

/**
 * 真实聚合器 + 真实候选筛。
 * 候选筛（isGoalPlanMetaCandidate 由生产导出）只决定要不要 hydrate，结论仍只由决策出口给。
 */
function buildAggregator({ plan, conversation, streams = [] }) {
  return createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: (options = {}) => [plan].filter((entry) => (
        typeof options.candidateFilter === 'function'
          ? options.candidateFilter(entry) === true
          : true
      )),
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [conversation],
    listActiveStreams: () => streams,
  });
}

function conversationOf(id, updatedAt) {
  return {
    id,
    title: id,
    workspacePath: WORKSPACE,
    updatedAt,
    // 已读水位晚于更新：断言的是生命周期文案，不是「有未读」。
    lastReadAt: new Date(Date.parse(updatedAt) + 60 * 60 * 1000).toISOString(),
  };
}

const FIVE_FIELDS = ['status', 'statusLabel', 'actionRight', 'nextAction', 'cancelable'];
// 列表卡不带 `status`（卡片只呈现文案+行动权+下一步+取消），会话行才带 status。
const CARD_FIELDS = ['statusLabel', 'actionRight', 'nextAction', 'cancelable'];

/**
 * 同一快照走完三个表面 + 渲染消费层：
 * - 唯一决策出口 decideLifecycle
 * - 任务卡/列表投影 projectGoalPlan
 * - 会话（抽屉）投影 projectWorkSession
 * - 实际桌面列表产出（createTaskOverviewAggregator.listTaskOverview）
 * 五字段任一不一致立即失败；不允许出现测试专用的第二套决策器。
 */
function assertOneDecisionAcrossSurfaces({ plan, conversation, streams = [], snapshotOptions = {} }) {
  const snapshot = toGoalPlanSnapshot(plan, snapshotOptions);
  assert.ok(snapshot, '生产 toGoalPlanSnapshot 必须产出快照');

  const decision = decideLifecycle(snapshot);
  const goalCard = projectGoalPlan(snapshot);
  const session = projectWorkSession(snapshot, CONVERSATION_META);
  const item = buildAggregator({ plan, conversation, streams })
    .listTaskOverview({ activeWithinMs: 0 })
    .find((entry) => entry.source === 'goal_plan');
  assert.ok(item, '列表里必须有这条 GoalPlan 卡片');

  for (const [surface, value, fields] of [
    ['goalCard', goalCard, CARD_FIELDS],
    ['session', session, FIVE_FIELDS],
    ['item', item, CARD_FIELDS],
  ]) {
    for (const field of fields) {
      assert.equal(
        value[field],
        decision[field],
        `${surface}.${field} 必须与唯一决策出口同源（实际 ${String(value[field])}，决策 ${String(decision[field])}）`,
      );
    }
  }

  // 渲染消费层只能消费决策，不能自己重算一遍。
  assert.equal(canCancelTask(item.status, item.cancelable), decision.cancelable);
  assert.equal(canCancelTask(session.status, session.cancelable), decision.cancelable);
  assert.equal(canCancelTask(item.status, item.cancelable), item.cancelable);

  return { decision, item };
}

test('completed + 预算耗尽（所有权 unknown）：列表/任务卡/会话/渲染一致，预算门可见', () => {
  const plan = {
    planId: 'plan-budget-unknown',
    conversationId: 'conversation-budget-unknown',
    title: '预算耗尽但计划已落完成',
    status: 'completed',
    updatedAt: '2026-08-09T02:00:00.000Z',
    targetWorkspacePath: WORKSPACE,
    delegated: true,
    runner: { status: 'budget_exhausted' },
  };
  const { decision, item } = assertOneDecisionAcrossSurfaces({
    plan,
    conversation: conversationOf('conversation-budget-unknown', plan.updatedAt),
    snapshotOptions: { executionOwnership: 'unknown' },
  });

  assert.equal(decision.status, 'waiting_user');
  assert.equal(decision.actionRight, 'needs_you');
  assert.equal(decision.needsYouReason, 'decision');
  assert.equal(decision.nextAction, 'decide_blocked');
  assert.equal(decision.statusLabel, '预算已耗尽');
  assert.equal(decision.cancelable, true);
  assert.equal(item.source, 'goal_plan');
});

test('completed + 预算耗尽（所有权 ended）：结束不等于决策已消费', () => {
  const plan = {
    planId: 'plan-budget-ended',
    conversationId: 'conversation-budget-ended',
    title: '执行体已结束但预算门未消费',
    status: 'completed',
    updatedAt: '2026-08-09T02:10:00.000Z',
    targetWorkspacePath: WORKSPACE,
    delegated: true,
    runner: { status: 'budget_exhausted' },
  };
  const { decision } = assertOneDecisionAcrossSurfaces({
    plan,
    conversation: conversationOf('conversation-budget-ended', plan.updatedAt),
    snapshotOptions: { executionOwnership: 'ended' },
  });

  assert.equal(decision.status, 'waiting_user');
  assert.equal(decision.actionRight, 'needs_you');
  assert.equal(decision.nextAction, 'decide_blocked');
  assert.notEqual(decision.status, 'running');
});

test('completed + 待回答（所有权 unknown）：列表不再只剩已读会话行', () => {
  const plan = {
    planId: 'plan-question-unknown',
    conversationId: 'conversation-question-unknown',
    title: '等你选一个方案',
    status: 'completed',
    updatedAt: '2026-08-09T02:20:00.000Z',
    targetWorkspacePath: WORKSPACE,
    delegated: true,
    needsUser: true,
    runner: { status: 'waiting_user' },
  };
  const { decision, item } = assertOneDecisionAcrossSurfaces({
    plan,
    conversation: conversationOf('conversation-question-unknown', plan.updatedAt),
    snapshotOptions: { executionOwnership: 'unknown' },
  });

  assert.equal(decision.status, 'waiting_user');
  assert.equal(decision.actionRight, 'needs_you');
  assert.equal(decision.nextAction, 'answer_question');
  assert.equal(decision.statusLabel, '等待你的选择');
  assert.equal(item.actionRight, 'needs_you');
});

test('completed + 待回答（所有权 ended）：所有权未知/结束都不制造「还在跑」', () => {
  const plan = {
    planId: 'plan-question-ended',
    conversationId: 'conversation-question-ended',
    title: '执行体已结束，问题还在',
    status: 'completed',
    updatedAt: '2026-08-09T02:30:00.000Z',
    targetWorkspacePath: WORKSPACE,
    delegated: true,
    needsUser: true,
    runner: { status: 'waiting_user' },
  };
  const { decision } = assertOneDecisionAcrossSurfaces({
    plan,
    conversation: conversationOf('conversation-question-ended', plan.updatedAt),
    snapshotOptions: { executionOwnership: 'ended' },
  });

  assert.equal(decision.status, 'waiting_user');
  assert.equal(decision.actionRight, 'needs_you');
  assert.equal(decision.nextAction, 'answer_question');
});

test('活体优先：真实活流下，列表/会话/任务卡都随决策报 running', () => {
  const plan = {
    planId: 'plan-live-running',
    conversationId: 'conversation-live-running',
    title: '还在跑的任务',
    status: 'executing',
    updatedAt: '2026-08-09T02:40:00.000Z',
    targetWorkspacePath: WORKSPACE,
    delegated: true,
    runner: { status: 'running' },
  };
  const { decision, item } = assertOneDecisionAcrossSurfaces({
    plan,
    conversation: conversationOf('conversation-live-running', plan.updatedAt),
    streams: [{ conversationId: 'conversation-live-running' }],
    snapshotOptions: { executionOwnership: 'live', conversationLive: true },
  });

  assert.equal(decision.status, 'running');
  assert.equal(item.statusLabel, 'Peer 正在推进');
  assert.notEqual(item.actionRight, 'needs_you');
});

test('已验收的 completed 不再因为「可能有门」被拉回列表', () => {
  const plan = {
    planId: 'plan-accepted',
    conversationId: 'conversation-accepted',
    title: '已验收结束',
    status: 'completed',
    updatedAt: '2026-08-09T02:50:00.000Z',
    targetWorkspacePath: WORKSPACE,
    delegated: true,
    resultAcceptance: { acceptedAt: '2026-08-09T03:00:00.000Z' },
    runner: { status: 'budget_exhausted' },
  };
  const item = buildAggregator({
    plan,
    conversation: conversationOf('conversation-accepted', plan.updatedAt),
  })
    .listTaskOverview({ activeWithinMs: 0 })
    .find((entry) => entry.source === 'goal_plan');

  assert.equal(item, undefined, '已验收 = 真结束，不能凭残留 runner 复活');
});
