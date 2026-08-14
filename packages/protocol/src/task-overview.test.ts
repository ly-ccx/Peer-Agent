import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isConversationUnreadForDiscussion,
  projectAutomationRun,
  projectConversation,
  projectGoalPlan,
  projectShellBackgroundTask,
  type AutomationProjectionSnapshot,
  type ConversationProjectionSnapshot,
  type GoalPlanProjectionSnapshot,
} from './task-overview.ts';

// ---------------------------------------------------------------------------
// Conversation 讨论态投影（工作台动线 §15）
// ---------------------------------------------------------------------------

function conversationSnapshot(
  overrides: Partial<ConversationProjectionSnapshot> = {},
): ConversationProjectionSnapshot {
  return {
    conversationId: 'conversation-1',
    title: '讨论 Task 与 Plan 的界面关系',
    workspaceLabel: 'peer_agent',
    updatedAt: '2026-08-09T01:00:00.000Z',
    ...overrides,
  };
}

test('projects a conversation without a GoalPlan as a discussion task', () => {
  assert.deepEqual(projectConversation(conversationSnapshot()), {
    taskId: 'conversation-1',
    source: 'conversation',
    actionRight: 'paused',
    nextAction: 'continue_task',
    title: '讨论 Task 与 Plan 的界面关系',
    workspaceLabel: 'peer_agent',
    statusLabel: '有未读',
    isUnread: true,
    lastActiveAt: '2026-08-09T01:00:00.000Z',
    actionLabel: '打开',
    conversationId: 'conversation-1',
  });
});

test('conversation discussion projection never invents plan progress or steps', () => {
  const item = projectConversation(conversationSnapshot());
  assert.equal(item.planProgress, undefined);
  assert.equal(item.planSteps, undefined);
});

test('conversation discussion projection exposes read state without removing history', () => {
  const item = projectConversation(
    conversationSnapshot({ lastReadAt: '2026-08-09T01:30:00.000Z' }),
  );
  assert.equal(item.conversationId, 'conversation-1');
  assert.equal(item.statusLabel, '已读');
  assert.equal(item.isUnread, false);
});

test('isConversationUnreadForDiscussion compares updatedAt and lastReadAt', () => {
  assert.equal(
    isConversationUnreadForDiscussion({
      updatedAt: '2026-08-09T02:00:00.000Z',
      lastReadAt: '2026-08-09T01:00:00.000Z',
    }),
    true,
  );
  assert.equal(
    isConversationUnreadForDiscussion({
      updatedAt: '2026-08-09T01:00:00.000Z',
      lastReadAt: '2026-08-09T01:30:00.000Z',
    }),
    false,
  );
  // 无 lastReadAt 视为未读（兼容旧数据）
  assert.equal(
    isConversationUnreadForDiscussion({ updatedAt: '2026-08-09T01:00:00.000Z' }),
    true,
  );
  assert.equal(isConversationUnreadForDiscussion({}), false);
});

// ---------------------------------------------------------------------------
// GoalPlan 投影分支（§11.3 rule 1/2/5/6/8/9/11/12/13/14/16）
// ---------------------------------------------------------------------------

function goalSnapshot(
  overrides: Partial<GoalPlanProjectionSnapshot> = {},
): GoalPlanProjectionSnapshot {
  return {
    planId: 'plan-1',
    status: 'executing',
    title: '示例任务',
    workspaceLabel: 'peer_agent',
    progress: { completed: 3, total: 5 },
    updatedAt: '2026-08-07T00:00:00.000Z',
    conversationId: 'conv-1',
    ...overrides,
  };
}

test('rule 1: awaiting_approval → needs_you / plan_approval', () => {
  const item = projectGoalPlan(goalSnapshot({ status: 'awaiting_approval' }));
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'plan_approval');
  assert.equal(item.nextAction, 'approve_plan');
  assert.equal(item.statusLabel, '待批准计划');
});

test('rule 2: drafting → needs_you / plan_approval', () => {
  const item = projectGoalPlan(goalSnapshot({ status: 'drafting' }));
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'plan_approval');
  assert.equal(item.nextAction, 'confirm_scope');
});

test('rule 4: runner waiting_user → needs_you / user_input / answer_question', () => {
  const item = projectGoalPlan(
    goalSnapshot({ status: 'executing', runnerStatus: 'waiting_user' }),
  );
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'user_input');
  assert.equal(item.nextAction, 'answer_question');
  assert.equal(item.statusLabel, '等待你的选择');
});

test('request_user_input stays needs_you even after the current leaf reached 100%', () => {
  const item = projectGoalPlan(
    goalSnapshot({
      status: 'executing',
      runnerStatus: 'waiting_user',
      progress: { total: 1, completed: 1 },
    }),
  );
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'user_input');
  assert.equal(item.nextAction, 'answer_question');
  assert.equal(item.statusLabel, '等待你的选择');
});

test('request_user_input outranks stale completed until the answer is consumed', () => {
  const item = projectGoalPlan(
    goalSnapshot({
      status: 'completed',
      runnerStatus: 'waiting_user',
      progress: { total: 1, completed: 1 },
      accepted: false,
    }),
  );
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'user_input');
  assert.equal(item.nextAction, 'answer_question');
  assert.equal(item.statusLabel, '等待你的选择');
});

test('rule 5: runner blocked → needs_you / decision', () => {
  const item = projectGoalPlan(
    goalSnapshot({ status: 'executing', runnerStatus: 'blocked' }),
  );
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'decision');
  assert.equal(item.nextAction, 'decide_blocked');
  assert.equal(item.statusLabel, '执行受阻');
});

test('recoverable system blocker does not become a user decision', () => {
  const item = projectGoalPlan(
    goalSnapshot({
      status: 'executing',
      runnerStatus: 'blocked',
      systemBlocked: true,
    }),
  );
  assert.equal(item.actionRight, 'paused');
  assert.equal(item.needsYouReason, undefined);
  assert.equal(item.nextAction, 'inspect');
  assert.equal(item.statusLabel, '系统执行中断');
});

test('rule 5b: runner budget_exhausted → needs_you / decision', () => {
  const item = projectGoalPlan(
    goalSnapshot({ status: 'executing', runnerStatus: 'budget_exhausted' }),
  );
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'decision');
  assert.equal(item.statusLabel, '预算已耗尽');
  assert.equal(item.actionLabel, '决策');
});

test('rule 5c: 历史终态上的 runner.blocked 不得进 needs_you', () => {
  const failed = projectGoalPlan(
    goalSnapshot({ status: 'failed', runnerStatus: 'blocked' }),
  );
  assert.equal(failed.actionRight, 'terminal');
  assert.equal(failed.statusLabel, '已失败');

  const cancelled = projectGoalPlan(
    goalSnapshot({ status: 'cancelled', runnerStatus: 'budget_exhausted' }),
  );
  assert.equal(cancelled.actionRight, 'terminal');
});

test('未消费的 stream 中断优先于 completed 待验收并提供继续入口', () => {
  const item = projectGoalPlan(
    goalSnapshot({
      status: 'completed',
      runnerStatus: 'failed',
      interrupted: true,
      interruptionReason: '连接意外断开',
      accepted: false,
    }),
  );
  assert.equal(item.actionRight, 'paused');
  assert.equal(item.nextAction, 'resume');
  assert.equal(item.statusLabel, '执行中断');
  assert.equal(item.actionLabel, '继续 →');
  assert.equal(item.issueDetail, '连接意外断开');
});

test('rule 6: completed 未验收 → result_ready', () => {
  const item = projectGoalPlan(goalSnapshot({ status: 'completed', accepted: false }));
  assert.equal(item.actionRight, 'result_ready');
  assert.equal(item.nextAction, 'review_result');
  assert.equal(item.statusLabel, '待用户验收');
  assert.equal(item.actionLabel, '查看结果');
});

test('completed 但质量自检未过线时仍算正在处理，不进待验收', () => {
  const item = projectGoalPlan(goalSnapshot({
    status: 'completed',
    accepted: false,
    requiresQualityReview: true,
    qualityReviewStatus: 'reviewing',
  }));
  assert.equal(item.actionRight, 'peer_advancing');
  assert.equal(item.statusLabel, 'Peer 正在自检');
  assert.notEqual(item.actionRight, 'result_ready');
});

test('completed 且需要自检但尚未写入过线结果时，不得进入待验收', () => {
  const item = projectGoalPlan(goalSnapshot({
    status: 'completed',
    accepted: false,
    requiresQualityReview: true,
  }));
  assert.equal(item.actionRight, 'peer_advancing');
  assert.equal(item.statusLabel, 'Peer 正在自检');
  assert.notEqual(item.actionRight, 'result_ready');
});

test('completed 且质量自检过线后才进入待验收', () => {
  const item = projectGoalPlan(goalSnapshot({
    status: 'completed',
    accepted: false,
    requiresQualityReview: true,
    qualityReviewStatus: 'passed',
    qualityChecks: [{ id: 'intent', label: '对照你的目标', status: 'passed' }],
  }));
  assert.equal(item.actionRight, 'result_ready');
  assert.equal(item.qualityReviewStatus, 'passed');
  assert.equal(item.qualityChecks?.[0]?.label, '对照你的目标');
});

test('completed 且质量自检过线后，即使 runner 仍残留 running 也进入待验收', () => {
  const item = projectGoalPlan(goalSnapshot({
    status: 'completed',
    accepted: false,
    runnerStatus: 'running',
    requiresQualityReview: true,
    qualityReviewStatus: 'passed',
  }));
  assert.equal(item.actionRight, 'result_ready');
  assert.equal(item.statusLabel, '待用户验收');
  assert.notEqual(item.statusLabel, 'Peer 正在自检');
});

test('rule 16a: completed 已验收 → terminal', () => {
  const item = projectGoalPlan(goalSnapshot({ status: 'completed', accepted: true }));
  assert.equal(item.actionRight, 'terminal');
  assert.equal(item.statusLabel, '已验收');
});

test('rule 16b: cancelled / failed → terminal', () => {
  assert.equal(
    projectGoalPlan(goalSnapshot({ status: 'cancelled' })).actionRight,
    'terminal',
  );
  assert.equal(
    projectGoalPlan(goalSnapshot({ status: 'failed' })).statusLabel,
    '已失败',
  );
});

test('rule 8: executing（无 runner 态）→ peer_advancing', () => {
  const item = projectGoalPlan(goalSnapshot({ status: 'executing' }));
  assert.equal(item.actionRight, 'peer_advancing');
  assert.equal(item.statusLabel, 'Peer 正在推进');
});

test('rule 9: runner running/exploring → peer_advancing', () => {
  for (const runnerStatus of ['running', 'exploring', 'compacting_context'] as const) {
    const item = projectGoalPlan(goalSnapshot({ status: 'executing', runnerStatus }));
    assert.equal(item.actionRight, 'peer_advancing', `runner=${runnerStatus}`);
  }
});

test('rule 11: approved/accepted（Runner 未启动）→ peer_advancing', () => {
  for (const status of ['approved', 'accepted'] as const) {
    const item = projectGoalPlan(goalSnapshot({ status }));
    assert.equal(item.actionRight, 'peer_advancing', `status=${status}`);
    assert.equal(item.statusLabel, '排队待执行');
  }
});

test('rule 12: plan paused → paused / resume', () => {
  const item = projectGoalPlan(goalSnapshot({ status: 'paused' }));
  assert.equal(item.actionRight, 'paused');
  assert.equal(item.nextAction, 'resume');
});

test('rule 13: runner paused → paused / resume', () => {
  const item = projectGoalPlan(
    goalSnapshot({ status: 'executing', runnerStatus: 'paused' }),
  );
  assert.equal(item.actionRight, 'paused');
  assert.equal(item.nextAction, 'resume');
});

test('rule 14: executing + runner idle → 异常态 paused / inspect', () => {
  const item = projectGoalPlan(
    goalSnapshot({ status: 'executing', runnerStatus: 'idle' }),
  );
  assert.equal(item.actionRight, 'paused');
  assert.equal(item.nextAction, 'inspect');
  assert.equal(item.statusLabel, '推进中断');
});

test('投影产物携带 UI 所需字段', () => {
  const item = projectGoalPlan(goalSnapshot({ status: 'awaiting_approval' }));
  assert.equal(item.taskId, 'plan-1');
  assert.equal(item.source, 'goal_plan');
  assert.equal(item.title, '示例任务');
  assert.equal(item.workspaceLabel, 'peer_agent');
  assert.deepEqual(item.planProgress, { completed: 3, total: 5 });
  assert.equal(item.lastActiveAt, '2026-08-07T00:00:00.000Z');
  assert.equal(item.conversationId, 'conv-1');
});

// ---------------------------------------------------------------------------
// Automation 投影分支（§11.3 rule 3/4/7/10/15/17/18）
// ---------------------------------------------------------------------------

function automationSnapshot(
  overrides: Partial<AutomationProjectionSnapshot> = {},
): AutomationProjectionSnapshot {
  return {
    automationId: 'auto-1',
    runId: 'run-1',
    definitionStatus: 'active',
    runStatus: 'running',
    title: '发布检查',
    workspaceLabel: 'peer-knowledge',
    updatedAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

test('rule 3: run waiting_permission → needs_you / user_input / grant_permission', () => {
  const item = projectAutomationRun(
    automationSnapshot({ runStatus: 'waiting_permission' }),
  );
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'user_input');
  assert.equal(item.nextAction, 'grant_permission');
  assert.equal(item.statusLabel, '等待权限');
});

test('rule 4: run waiting_user → needs_you / user_input / answer_question', () => {
  const item = projectAutomationRun(automationSnapshot({ runStatus: 'waiting_user' }));
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'user_input');
  assert.equal(item.nextAction, 'answer_question');
});

test('rule 7 方案 A: run succeeded → terminal（不进待验收）', () => {
  const unaccepted = projectAutomationRun(
    automationSnapshot({ runStatus: 'succeeded', accepted: false }),
  );
  assert.equal(unaccepted.actionRight, 'terminal');
  assert.equal(unaccepted.nextAction, 'none');
  assert.equal(unaccepted.statusLabel, '已完成');

  // accepted 与否都不进 result_ready
  const accepted = projectAutomationRun(
    automationSnapshot({ runStatus: 'succeeded', accepted: true }),
  );
  assert.equal(accepted.actionRight, 'terminal');
});

test('rule 10: run running/queued/preparing/scheduled → peer_advancing', () => {
  for (const runStatus of ['running', 'queued', 'preparing', 'scheduled'] as const) {
    const item = projectAutomationRun(automationSnapshot({ runStatus }));
    assert.equal(item.actionRight, 'peer_advancing', `run=${runStatus}`);
  }
});

test('rule 15: definition paused/disabled → paused / enable', () => {
  for (const definitionStatus of ['paused', 'disabled'] as const) {
    const item = projectAutomationRun(
      automationSnapshot({ definitionStatus, runStatus: undefined }),
    );
    assert.equal(item.actionRight, 'paused', `def=${definitionStatus}`);
    assert.equal(item.nextAction, 'enable');
  }
});

test('rule 17: run 终态（succeeded / failed / timed_out 等）→ terminal', () => {
  const terminalRuns = ['succeeded', 'failed', 'cancelled', 'skipped', 'timed_out', 'blocked'] as const;
  for (const runStatus of terminalRuns) {
    const item = projectAutomationRun(automationSnapshot({ runStatus }));
    assert.equal(item.actionRight, 'terminal', `run=${runStatus}`);
  }
});

test('rule 18: definition completed/archived → terminal', () => {
  for (const definitionStatus of ['completed', 'archived'] as const) {
    const item = projectAutomationRun(
      automationSnapshot({ definitionStatus, runStatus: undefined }),
    );
    assert.equal(item.actionRight, 'terminal', `def=${definitionStatus}`);
  }
});

test('definition active 且无 Run → 调度待机 peer_advancing', () => {
  const item = projectAutomationRun(
    automationSnapshot({ definitionStatus: 'active', runStatus: undefined }),
  );
  assert.equal(item.actionRight, 'peer_advancing');
  assert.equal(item.statusLabel, '调度待机');
});

test('Automation 投影 taskId 优先 runId', () => {
  const withRun = projectAutomationRun(automationSnapshot({ runId: 'run-9' }));
  assert.equal(withRun.taskId, 'run-9');
  const noRun = projectAutomationRun(automationSnapshot({ runId: undefined }));
  assert.equal(noRun.taskId, 'auto-1');
  assert.equal(noRun.source, 'automation');
});

test('projectGoalPlan 透传 planSteps；空列表不写字段', () => {
  const steps = [
    { taskId: 's1', title: '扩展契约', status: 'completed' as const },
    { taskId: 's2', title: '渲染步骤', status: 'running' as const, current: true },
  ];
  const withSteps = projectGoalPlan(goalSnapshot({ planSteps: steps }));
  assert.deepEqual(withSteps.planSteps, steps);

  const empty = projectGoalPlan(goalSnapshot({ planSteps: [] }));
  assert.equal(empty.planSteps, undefined);

  const absent = projectGoalPlan(goalSnapshot());
  assert.equal(absent.planSteps, undefined);
});

test('projectGoalPlan 从 timing 投影 durationMs，并透传 modelLabel / providerLabel', () => {
  const nowMs = Date.parse('2026-08-10T00:01:00.000Z');
  const item = projectGoalPlan(
    goalSnapshot({
      modelLabel: ' grok-4.5 ',
      providerLabel: ' xai ',
      timing: {
        startedAt: '2026-08-10T00:00:00.000Z',
        activeAccumulatedMs: 15_000,
        activeSegmentStartedAt: '2026-08-10T00:00:45.000Z',
      },
    }),
    { nowMs },
  );
  // 15s 累计 + 15s open segment = 30s
  assert.equal(item.durationMs, 30_000);
  assert.equal(item.modelLabel, 'grok-4.5');
  assert.equal(item.providerLabel, 'xai');

  const without = projectGoalPlan(goalSnapshot());
  assert.equal(without.durationMs, undefined);
  assert.equal(without.modelLabel, undefined);
  assert.equal(without.providerLabel, undefined);
});

test('projectGoalPlan 透传 timing.completedAt 为 completedAt', () => {
  const item = projectGoalPlan(
    goalSnapshot({
      status: 'completed',
      accepted: false,
      updatedAt: '2026-08-10T00:05:00.000Z',
      timing: {
        startedAt: '2026-08-10T00:00:00.000Z',
        completedAt: '2026-08-10T00:03:00.000Z',
        activeAccumulatedMs: 180_000,
      },
    }),
  );
  assert.equal(item.actionRight, 'result_ready');
  assert.equal(item.completedAt, '2026-08-10T00:03:00.000Z');
  assert.equal(item.lastActiveAt, '2026-08-10T00:05:00.000Z');
});

test('projectGoalPlan 终态缺 timing.completedAt 时回落 updatedAt', () => {
  const item = projectGoalPlan(
    goalSnapshot({
      status: 'completed',
      accepted: false,
      updatedAt: '2026-08-10T00:05:00.000Z',
    }),
  );
  assert.equal(item.actionRight, 'result_ready');
  assert.equal(item.completedAt, '2026-08-10T00:05:00.000Z');
});

test('projectGoalPlan 非终态不写 completedAt', () => {
  const item = projectGoalPlan(
    goalSnapshot({
      status: 'executing',
      updatedAt: '2026-08-10T00:05:00.000Z',
      timing: {
        startedAt: '2026-08-10T00:00:00.000Z',
        activeAccumulatedMs: 10_000,
      },
    }),
  );
  assert.equal(item.completedAt, undefined);
});

test('projectConversation 透传 modelLabel / providerLabel', () => {
  const item = projectConversation(
    conversationSnapshot({ modelLabel: 'gpt-5.6', providerLabel: 'openai' }),
  );
  assert.equal(item.modelLabel, 'gpt-5.6');
  assert.equal(item.providerLabel, 'openai');
});

test('shell_background running → peer_advancing and open_background_thread', () => {
  const item = projectShellBackgroundTask({
    taskId: 'task-bg-1',
    command: 'npm test -- --watch',
    status: 'running',
    workspaceLabel: 'peer_agent',
    startedAt: '2026-08-10T00:00:00.000Z',
  });
  assert.equal(item.source, 'shell_background');
  assert.equal(item.taskId, 'shell:task-bg-1');
  assert.equal(item.actionRight, 'peer_advancing');
  assert.equal(item.nextAction, 'open_background_thread');
  assert.equal(item.statusLabel, '后台线程运行中');
  assert.equal(item.actionLabel, '查看线程 →');
});

test('projectGoalPlan 透传交付路由，不把缺分支补成 main', () => {
  const item = projectGoalPlan(goalSnapshot({
    deliveryRoute: '来源 peer-knowledge · 交付 peer_agent · PeerAgent/0.0.4',
  }));
  assert.equal(item.deliveryRoute, '来源 peer-knowledge · 交付 peer_agent · PeerAgent/0.0.4');
  assert.notEqual(item.deliveryRoute, 'main');
});

test('projectGoalPlan 透传交回状态，没隔离或没验收时不显示', () => {
  const shown = projectGoalPlan(goalSnapshot({
    deliveryHandoffLabel: '已交回 peer_agent / PeerAgent/0.0.4',
  }));
  assert.equal(shown.deliveryHandoffLabel, '已交回 peer_agent / PeerAgent/0.0.4');
  const hidden = projectGoalPlan(goalSnapshot({}));
  assert.equal(hidden.deliveryHandoffLabel, undefined);
});

test('shell_background cancelled → terminal', () => {
  const item = projectShellBackgroundTask({
    taskId: 'task-bg-2',
    command: 'sleep 30',
    status: 'cancelled',
    completedAt: '2026-08-10T00:01:00.000Z',
  });
  assert.equal(item.actionRight, 'terminal');
  assert.equal(item.statusLabel, '后台线程已停止');
});
