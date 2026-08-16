import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGoalThreadRelationIndex,
  capTaskOverviewByBucket,
  createTaskOverviewAggregator,
  currentStepTitleFromItem,
  displayConversationTitle,
  deriveTaskArtifacts,
  expandGoalThreadRelatives,
  extractPlanSteps,
  MAX_TASK_OVERVIEW_ARTIFACTS,
  looksLikeOpaqueId,
  modelLabelFromConversation,
  providerLabelFromConversation,
  resolveConversationModelLabels,
  sortTaskOverview,
  toAutomationSnapshot,
  toGoalPlanSnapshot,
  isGoalPlanInScope,
  isGoalThreadContextPlan,
  isPlanResultAccepted,
  RESULT_ACCEPTANCE_REQUIRED_SINCE,
  isAutomationInScope,
  DEFAULT_HOME_LIMIT,
  DEFAULT_RESULT_READY_WITHIN_MS,
  DEFAULT_RESULT_READY_LIMIT,
} from './task-overview-aggregator.mjs';

// ---------------------------------------------------------------------------
// Conversation 讨论态与 GoalPlan 去重
// ---------------------------------------------------------------------------

test('GoalPlan unread state follows the persisted conversation read watermark', () => {
  const conversations = [
    {
      id: 'conversation-1',
      title: '任务会话',
      workspacePath: '/work/peer_agent',
      updatedAt: '2026-08-09T02:00:00.000Z',
      lastReadAt: '2026-08-09T01:00:00.000Z',
    },
  ];
  const marked = [];
  const plan = {
    planId: 'plan-1',
    conversationId: 'conversation-1',
    title: '验证阅读水位',
    status: 'executing',
    updatedAt: '2026-08-09T02:00:00.000Z',
    targetWorkspacePath: '/work/peer_agent',
    runner: { status: 'running' },
  };
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [plan],
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => conversations,
    markTaskRead: (conversationId) => marked.push(conversationId),
  });

  assert.equal(agg.listTaskOverview({ activeWithinMs: 0 })[0].isUnread, true);
  assert.deepEqual(
    agg.markTasksRead({ conversationIds: ['conversation-1', 'conversation-1', ''] }),
    { markedCount: 1 },
  );
  assert.deepEqual(marked, ['conversation-1']);

  conversations[0].lastReadAt = '2026-08-09T02:00:00.000Z';
  assert.equal(agg.listTaskOverview({ activeWithinMs: 0 })[0].isUnread, false);
  conversations[0].updatedAt = '2026-08-09T03:00:00.000Z';
  plan.updatedAt = '2026-08-09T03:00:00.000Z';
  assert.equal(agg.listTaskOverview({ activeWithinMs: 0 })[0].isUnread, true);
});

test('aggregator projects conversations without GoalPlans as discussion tasks', () => {
  const agg = createTaskOverviewAggregator({
    goalPlanStore: { listPlanDetails: () => [] },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [
      {
        id: 'conversation-1',
        title: '讨论 Task 与 Plan 的界面关系',
        workspacePath: '/work/peer_agent',
        updatedAt: '2026-08-09T01:00:00.000Z',
      },
    ],
  });

  const items = agg.listTaskOverview({ activeWithinMs: 0 });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'conversation');
  assert.equal(items[0].title, '讨论 Task 与 Plan 的…');
  assert.equal(items[0].statusLabel, '有未读');
  assert.equal(items[0].actionLabel, '打开');
});

test('aggregator keeps read and unread conversations in discussion history', () => {
  const agg = createTaskOverviewAggregator({
    goalPlanStore: { listPlanDetails: () => [] },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [
      {
        id: 'conversation-read',
        title: '已经看过的沟通',
        workspacePath: '/work/peer_agent',
        updatedAt: '2026-08-09T01:00:00.000Z',
        lastReadAt: '2026-08-09T01:30:00.000Z',
      },
      {
        id: 'conversation-unread',
        title: '有新消息未读',
        workspacePath: '/work/peer_agent',
        updatedAt: '2026-08-09T02:00:00.000Z',
        lastReadAt: '2026-08-09T01:00:00.000Z',
      },
    ],
  });

  const items = agg.listTaskOverview({ activeWithinMs: 0 });
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => [item.conversationId, item.statusLabel, item.isUnread]),
    [
      ['conversation-unread', '有未读', true],
      ['conversation-read', '已读', false],
    ],
  );
});

test('displayConversationTitle truncates long user text and rejects command-like titles', () => {
  assert.equal(displayConversationTitle('短标题'), '短标题');
  assert.equal(displayConversationTitle('这一段话废话太多了，你看看标题怎么精简一下').endsWith('…'), true);
  assert.equal(displayConversationTitle('> tsc -p tsconfig.build.json src/task-overview.ts'), '未命名沟通');
  assert.equal(displayConversationTitle('好，就这么做'), '未命名沟通');
  assert.equal(displayConversationTitle('认可'), '未命名沟通');
});

test('currentStepTitleFromItem prefers current plan step', () => {
  assert.equal(
    currentStepTitleFromItem({
      planSteps: [
        { taskId: 'a', title: '已完成', status: 'completed' },
        { taskId: 'b', title: '梳理行动权', status: 'running', current: true },
      ],
    }),
    '梳理行动权',
  );
});

test('aggregator keeps one Task per conversation and uses plan.title as main title', () => {
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [
        {
          planId: 'plan-old',
          conversationId: 'conversation-1',
          status: 'completed',
          title: '旧 Goal',
          updatedAt: '2026-08-09T01:30:00.000Z',
          resultAcceptance: { acceptedAt: '2026-08-09T01:45:00.000Z' },
        },
        {
          planId: 'plan-1',
          conversationId: 'conversation-1',
          status: 'executing',
          title: '实现 Task 上下文界面',
          updatedAt: '2026-08-09T02:00:00.000Z',
        },
      ],
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [
      {
        id: 'conversation-1',
        title: '讨论 Task 与 Plan 的界面关系',
        workspacePath: '/work/peer_agent',
        updatedAt: '2026-08-09T01:00:00.000Z',
      },
    ],
  });

  const items = agg.listTaskOverview({ activeWithinMs: 0 });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'goal_plan');
  assert.equal(items[0].conversationId, 'conversation-1');
  // 主标题固定 plan.title；会话原话不得压过任务名。
  assert.equal(items[0].title, '实现 Task 上下文界面');
  // 无 planSteps 时不伪造 currentGoalTitle（不再回填 plan 标题当「当前目标」）。
  assert.equal(items[0].currentGoalTitle, undefined);
});

test('aggregator projects every unaccepted result in one conversation as its own card', () => {
  const plans = [
    {
      planId: 'result-old',
      conversationId: 'conversation-results',
      status: 'completed',
      title: '第一项结果',
      updatedAt: '2026-08-09T01:00:00.000Z',
    },
    {
      planId: 'result-new',
      conversationId: 'conversation-results',
      status: 'completed',
      title: '第二项结果',
      updatedAt: '2026-08-09T02:00:00.000Z',
    },
    {
      planId: 'result-accepted',
      conversationId: 'conversation-results',
      status: 'completed',
      title: '已验收结果',
      updatedAt: '2026-08-09T03:00:00.000Z',
      resultAcceptance: { acceptedAt: '2026-08-09T03:30:00.000Z' },
    },
  ];
  const agg = createTaskOverviewAggregator({
    goalPlanStore: { listPlanDetails: () => plans },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [
      {
        id: 'conversation-results',
        title: '同一会话中的多项结果',
        workspacePath: '/work/peer_agent',
        updatedAt: '2026-08-09T03:00:00.000Z',
      },
    ],
  });

  const resultIds = () =>
    agg.listTaskOverview({ activeWithinMs: 0 })
      .filter((item) => item.actionRight === 'result_ready')
      .map((item) => item.taskId);
  assert.deepEqual(resultIds(), ['result-new', 'result-old']);

  plans[1].resultAcceptance = { acceptedAt: '2026-08-09T04:00:00.000Z' };
  assert.deepEqual(resultIds(), ['result-old']);
});

// ---------------------------------------------------------------------------
// 快照组装
// ---------------------------------------------------------------------------

test('toGoalPlanSnapshot 组装 workspace 标签 / progress / runner.status', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p1',
    status: 'executing',
    runner: { status: 'running' },
    title: '回归验证',
    targetWorkspacePath: '/Users/x/peer_agent',
    progress: { completed: 7, total: 9 },
    updatedAt: '2026-08-07T02:00:00Z',
    conversationId: 'c1',
  });
  assert.equal(snapshot.planId, 'p1');
  assert.equal(snapshot.runnerStatus, 'running');
  assert.equal(snapshot.interrupted, false);
  assert.equal(snapshot.workspaceLabel, 'peer_agent');
  assert.deepEqual(snapshot.progress, { completed: 7, total: 9 });
  assert.equal(snapshot.accepted, false);
});

test('分桶截断：result_ready 洪峰不再挤掉 peer_advancing 与 discussion', () => {
  const mk = (id, actionRight) => ({
    taskId: id,
    actionRight,
    title: `t-${id}`,
    lastActiveAt: '2026-08-14T00:00:00.000Z',
  });
  const flood = Array.from({ length: 500 }, (_, i) => mk(`r${i}`, 'result_ready'));
  const mixed = [
    mk('needs-1', 'needs_you'),
    ...flood,
    mk('adv-1', 'peer_advancing'),
    mk('adv-2', 'peer_advancing'),
    { ...mk('disc-1', 'discussion'), actionRight: 'discussion' },
  ];
  const sorted = mixed; // 排序已由 sortTaskOverview 保证；此处直接验证截断契约
  const capped = capTaskOverviewByBucket(sorted, 200);
  const byBucket = {};
  for (const item of capped) byBucket[item.actionRight] = (byBucket[item.actionRight] ?? 0) + 1;
  // result_ready 不限条（500 全保留）；行动权/讨论桶不被挤掉。
  assert.equal(byBucket.result_ready, 500);
  assert.equal(byBucket.needs_you, 1);
  assert.equal(byBucket.peer_advancing, 2);
  assert.equal(byBucket.discussion, 1);
  // 显式小配额仍然生效。
  const tight = capTaskOverviewByBucket(sorted, 200, 50);
  const tightResult = tight.filter((i) => i.actionRight === 'result_ready').length;
  assert.equal(tightResult, 50);
  assert.ok(tight.some((i) => i.actionRight === 'peer_advancing'));
});

test('目标线：带 parentPlanId 的 plan 投影出 rootPlanId/relationType/depth/round/rootPlanTitle', () => {
  const root = {
    planId: 'plan-root',
    status: 'completed',
    title: '统一工具栏圆角',
    createdAt: '2026-08-13T10:00:00.000Z',
    updatedAt: '2026-08-13T10:30:00.000Z',
    targetWorkspacePath: '/Users/x/peer-knowledge',
  };
  const derived = {
    planId: 'plan-r2',
    parentPlanId: 'plan-root',
    rootPlanId: 'plan-root',
    relationType: 'derived',
    depth: 1,
    status: 'completed',
    title: '截图验收工具栏圆角',
    createdAt: '2026-08-13T11:00:00.000Z',
    updatedAt: '2026-08-13T11:20:00.000Z',
    targetWorkspacePath: '/Users/x/peer-knowledge',
  };
  const relationIndex = buildGoalThreadRelationIndex([root, derived]);
  const snapshot = toGoalPlanSnapshot(derived, { relationIndex });
  assert.equal(snapshot.rootPlanId, 'plan-root');
  assert.equal(snapshot.parentPlanId, 'plan-root');
  assert.equal(snapshot.relationType, 'derived');
  assert.equal(snapshot.depth, 1);
  assert.equal(snapshot.round, 2);
  assert.equal(snapshot.rootPlanTitle, '统一工具栏圆角');
  // 根自身也投影出线归属，轮次为 1。
  const rootSnapshot = toGoalPlanSnapshot(root, { relationIndex });
  assert.equal(rootSnapshot.rootPlanId, 'plan-root');
  assert.equal(rootSnapshot.round, 1);
  assert.equal(rootSnapshot.parentPlanId, undefined);
});

test('目标线：sourceTaskId 兜底链也能解析出关系；旧数据无关系字段则缺键', () => {
  const parent = {
    planId: 'plan-a',
    status: 'completed',
    title: '第一轮目标',
    createdAt: '2026-08-13T09:00:00.000Z',
    updatedAt: '2026-08-13T09:10:00.000Z',
  };
  const child = {
    // 旧链路：store 校验过 sourceTaskId 指向父计划，但没有显式 parentPlanId。
    planId: 'plan-b',
    sourceTaskId: 'plan-a',
    status: 'completed',
    title: '追问派生轮',
    createdAt: '2026-08-13T09:30:00.000Z',
    updatedAt: '2026-08-13T09:40:00.000Z',
  };
  const relationIndex = buildGoalThreadRelationIndex([parent, child]);
  const snapshot = toGoalPlanSnapshot(child, { relationIndex });
  assert.equal(snapshot.rootPlanId, 'plan-a');
  assert.equal(snapshot.parentPlanId, 'plan-a');
  assert.equal(snapshot.relationType, 'derived');
  assert.equal(snapshot.round, 2);
  // 完全无关系事实的旧计划：四类字段全部缺键，UI 降级平铺。
  const legacy = toGoalPlanSnapshot({
    planId: 'plan-legacy',
    status: 'completed',
    title: '历史孤立计划',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }, { relationIndex });
  assert.equal(legacy.rootPlanId, undefined);
  assert.equal(legacy.parentPlanId, undefined);
  assert.equal(legacy.relationType, undefined);
  assert.equal(legacy.round, undefined);
  assert.equal(legacy.rootPlanTitle, undefined);
});

test('目标线：根计划自指 parentPlanId 仍能求出线根并与子计划归组', () => {
  const rootId = 'plan-self-root';
  const root = {
    planId: rootId,
    parentPlanId: rootId,
    sourceTaskId: 'orient',
    status: 'completed',
    title: '开 0.0.5 开发线',
    createdAt: '2026-08-15T04:20:00.000Z',
    updatedAt: '2026-08-15T04:32:00.000Z',
  };
  const child = {
    planId: 'plan-self-child',
    parentPlanId: rootId,
    sourceTaskId: 'commit',
    status: 'completed',
    title: '落地 @ 文件与会话',
    createdAt: '2026-08-15T04:40:00.000Z',
    updatedAt: '2026-08-15T04:58:00.000Z',
  };
  const relationIndex = buildGoalThreadRelationIndex([root, child]);
  assert.equal(relationIndex.rootPlanIdOf(rootId), rootId);
  assert.equal(relationIndex.parentPlanIdOf(rootId), undefined);
  assert.equal(relationIndex.roundOf(rootId), 1);
  assert.equal(relationIndex.rootPlanIdOf(child.planId), rootId);
  assert.equal(relationIndex.parentPlanIdOf(child.planId), rootId);
  assert.equal(relationIndex.roundOf(child.planId), 2);

  const rootSnapshot = toGoalPlanSnapshot(root, { relationIndex });
  const childSnapshot = toGoalPlanSnapshot(child, { relationIndex });
  assert.equal(rootSnapshot.rootPlanId, rootId);
  assert.equal(rootSnapshot.parentPlanId, undefined);
  assert.equal(rootSnapshot.round, 1);
  assert.equal(childSnapshot.rootPlanId, rootId);
  assert.equal(childSnapshot.parentPlanId, rootId);
  assert.equal(childSnapshot.round, 2);
});

test('toGoalPlanSnapshot 只有交付绑定才标出需要质量自检', () => {
  const workspaceOnly = toGoalPlanSnapshot({
    planId: 'p-workspace-only',
    status: 'completed',
    title: '实现跨仓交付',
    targetWorkspacePath: '/Users/x/peer_agent',
  });
  assert.equal(workspaceOnly.requiresQualityReview, undefined);

  const reviewing = toGoalPlanSnapshot({
    planId: 'p-reviewing',
    status: 'completed',
    title: '实现跨仓交付',
    targetWorkspacePath: '/Users/x/peer_agent',
    deliveryBinding: {
      repoId: 'peer_agent',
      targetBranch: 'PeerAgent/0.0.4',
      targetBranchSource: 'workspace_head',
      isolation: 'none',
    },
  });
  assert.equal(reviewing.requiresQualityReview, true);
  assert.equal(reviewing.qualityReviewStatus, undefined);

  const passed = toGoalPlanSnapshot({
    planId: 'p-passed',
    status: 'completed',
    title: '实现跨仓交付',
    targetWorkspacePath: '/Users/x/peer_agent',
    deliveryBinding: {
      repoId: 'peer_agent',
      targetBranch: 'PeerAgent/0.0.4',
      targetBranchSource: 'workspace_head',
      isolation: 'none',
    },
    qualityReview: { status: 'passed', reviewedAt: '2026-08-13T07:00:00.000Z' },
  });
  assert.equal(passed.requiresQualityReview, true);
  assert.equal(passed.qualityReviewStatus, 'passed');
});

test('toGoalPlanSnapshot 带上来源仓、交付仓和目标分支，不补 main', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p-route',
    status: 'executing',
    title: '实现跨仓交付',
    originWorkspacePath: '/Users/x/peer-knowledge',
    targetWorkspacePath: '/Users/x/peer_agent',
    targetRepoId: 'peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
  });
  assert.equal(snapshot.deliveryRoute, '来源 peer-knowledge · 交付 peer_agent · PeerAgent/0.0.4');
  assert.equal(snapshot.deliveryRoute?.includes('main'), false);

  const unbound = toGoalPlanSnapshot({
    planId: 'p-unbound',
    status: 'executing',
    title: '尚未确认目标分支',
    originWorkspacePath: '/Users/x/peer-knowledge',
    targetWorkspacePath: '/Users/x/peer_agent',
  });
  assert.equal(unbound.deliveryRoute, '来源 peer-knowledge · 交付 peer_agent · 目标分支未确认');
});

test('toGoalPlanSnapshot 隔离执行时写独立执行环境，不再写未隔离执行', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p-isolated',
    status: 'executing',
    title: '隔离执行',
    originWorkspacePath: '/Users/x/peer-knowledge',
    targetWorkspacePath: '/Users/x/peer_agent',
    targetRepoId: 'peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
    deliveryBinding: {
      repoId: 'peer_agent',
      targetWorkspacePath: '/Users/x/peer_agent',
      targetBranch: 'PeerAgent/0.0.4',
      targetBranchSource: 'workspace_head',
      executionIsolation: 'worktree',
      taskBranch: 'peer-goal/p-isolated',
      worktreePath: '/tmp/peer-goal-worktrees/p-isolated',
      boundAt: '2026-08-13T08:40:00.000Z',
    },
  });
  assert.equal(
    snapshot.deliveryRoute,
    '来源 peer-knowledge · 交付 peer_agent · PeerAgent/0.0.4 · 独立执行环境',
  );
  assert.equal(snapshot.deliveryRoute?.includes('未隔离执行'), false);
});

test('toGoalPlanSnapshot 已隔离且已验收时展示交回状态，否则不显示', () => {
  const isolatedBinding = {
    repoId: 'peer_agent',
    targetWorkspacePath: '/Users/x/peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
    executionIsolation: 'worktree',
    taskBranch: 'peer-goal/p-delivered',
    worktreePath: '/tmp/peer-goal-worktrees/p-delivered',
    boundAt: '2026-08-13T08:40:00.000Z',
  };
  const delivered = toGoalPlanSnapshot({
    planId: 'p-delivered',
    status: 'completed',
    title: '已交回',
    originWorkspacePath: '/Users/x/peer-knowledge',
    targetWorkspacePath: '/Users/x/peer_agent',
    targetRepoId: 'peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
    resultAcceptance: { acceptedAt: '2026-08-14T01:00:00.000Z', acceptedBy: 'user' },
    deliveryBinding: isolatedBinding,
    deliveryHandoff: {
      status: 'delivered',
      repoId: 'peer_agent',
      targetBranch: 'PeerAgent/0.0.4',
      updatedAt: '2026-08-14T01:01:00.000Z',
    },
  });
  assert.equal(delivered.deliveryHandoffLabel, '已交回 peer_agent / PeerAgent/0.0.4');

  const stopped = toGoalPlanSnapshot({
    planId: 'p-stopped',
    status: 'completed',
    title: '交回停止',
    originWorkspacePath: '/Users/x/peer-knowledge',
    targetWorkspacePath: '/Users/x/peer_agent',
    targetRepoId: 'peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
    resultAcceptance: { acceptedAt: '2026-08-14T01:00:00.000Z', acceptedBy: 'user' },
    deliveryBinding: isolatedBinding,
    deliveryHandoff: {
      status: 'stopped',
      stoppedReason: 'same_target_busy',
      updatedAt: '2026-08-14T01:01:00.000Z',
    },
  });
  assert.equal(stopped.deliveryHandoffLabel, '同一目标正在交回');

  const hidden = toGoalPlanSnapshot({
    planId: 'p-hidden',
    status: 'completed',
    title: '未验收不显示',
    originWorkspacePath: '/Users/x/peer-knowledge',
    targetWorkspacePath: '/Users/x/peer_agent',
    targetRepoId: 'peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
    deliveryBinding: isolatedBinding,
    deliveryHandoff: {
      status: 'delivered',
      repoId: 'peer_agent',
      targetBranch: 'PeerAgent/0.0.4',
      updatedAt: '2026-08-14T01:01:00.000Z',
    },
  });
  assert.equal(hidden.deliveryHandoffLabel, undefined);
});


test('toGoalPlanSnapshot classifies renderer unavailability as a system-owned blocker', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p-system-blocked',
    status: 'executing',
    runner: {
      status: 'blocked',
      blockedReason: 'No renderer window is available for Goal Runner',
    },
    title: '等待前台接管',
  });
  assert.equal(snapshot.runnerStatus, 'blocked');
  assert.equal(snapshot.systemBlocked, true);
});

test('toGoalPlanSnapshot keeps an auto-recovering runner active instead of projecting a manual interruption', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p-recovering',
    status: 'executing',
    runner: {
      status: 'running',
      phase: 'repair',
      interruption: {
        source: 'stream_error',
        reason: 'socket disconnected',
        interruptedAt: '2026-08-11T00:00:00.000Z',
        recoverable: true,
        attempt: 1,
      },
    },
    title: '恢复网络中断',
    updatedAt: '2026-08-11T00:00:01.000Z',
  });
  assert.equal(snapshot.interrupted, false);
  assert.equal(snapshot.runnerStatus, 'running');
});

test('toGoalPlanSnapshot 透传未消费的 runner interruption', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p-interrupted',
    status: 'failed',
    runner: {
      status: 'failed',
      interruption: {
        source: 'stream_error',
        reason: 'socket disconnected',
        interruptedAt: '2026-08-11T00:00:00.000Z',
      },
    },
    title: '中断任务',
  });
  assert.equal(snapshot.interrupted, true);
  assert.equal(snapshot.interruptionReason, 'socket disconnected');
});

test('aggregator keeps interrupted Goal as one paused item instead of discussion', () => {
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [{
        planId: 'p-interrupted',
        conversationId: 'conversation-interrupted',
        status: 'executing',
        runner: {
          status: 'failed',
          interruption: {
            source: 'stream_error',
            reason: 'socket disconnected',
            interruptedAt: '2026-08-11T00:00:00.000Z',
            recoverable: true,
          },
        },
        title: '修复执行中断归类',
        updatedAt: '2026-08-11T00:00:01.000Z',
      }],
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [{
      id: 'conversation-interrupted',
      title: '你还是没有解决中断的问题',
      workspacePath: '/work/peer_agent',
      updatedAt: '2026-08-11T00:00:02.000Z',
    }],
  });

  const items = agg.listTaskOverview({ activeWithinMs: 0 });
  assert.equal(items.length, 1);
  assert.equal(items[0].source, 'goal_plan');
  assert.equal(items[0].actionRight, 'paused');
  assert.equal(items[0].nextAction, 'resume');
  assert.equal(items[0].issueDetail, 'socket disconnected');
});

test('toGoalPlanSnapshot 透传 timing，并从会话解析 modelLabel / providerLabel', () => {
  const timing = {
    startedAt: '2026-08-10T00:00:00.000Z',
    activeAccumulatedMs: 12_000,
    activeSegmentStartedAt: '2026-08-10T00:00:30.000Z',
  };
  const snapshot = toGoalPlanSnapshot(
    {
      planId: 'p-timing',
      status: 'executing',
      title: '时长模型',
      timing,
      conversationId: 'c-model',
    },
    { conversation: { model: 'grok-4.5', modelProviderId: 'xai::grok-4.5' } },
  );
  assert.deepEqual(snapshot.timing, timing);
  assert.equal(snapshot.modelLabel, 'grok-4.5');
  assert.equal(snapshot.providerLabel, 'xai');
});

test('looksLikeOpaqueId 识别 UUID 配置 id', () => {
  assert.equal(looksLikeOpaqueId('f5ab0732-a158-4b60-919f-0e319147e183'), true);
  assert.equal(looksLikeOpaqueId('xai'), false);
  assert.equal(looksLikeOpaqueId('grok-4.5'), false);
});

test('modelLabelFromConversation 优先 model，回退 modelProviderId 末段；UUID 不展示', () => {
  assert.equal(modelLabelFromConversation({ model: 'gpt-5.6' }), 'gpt-5.6');
  assert.equal(modelLabelFromConversation({ modelProviderId: 'openai::gpt-5.6' }), 'gpt-5.6');
  assert.equal(modelLabelFromConversation({ modelProviderId: 'local/llama3' }), 'llama3');
  assert.equal(
    modelLabelFromConversation({ modelProviderId: 'f5ab0732-a158-4b60-919f-0e319147e183' }),
    undefined,
  );
  assert.equal(modelLabelFromConversation({}), undefined);
  assert.equal(modelLabelFromConversation(null), undefined);
});

test('providerLabelFromConversation 取可读 group 段；UUID 不展示', () => {
  assert.equal(providerLabelFromConversation({ modelProviderId: 'xai::grok-4.5' }), 'xai');
  assert.equal(providerLabelFromConversation({ modelProviderId: 'openai/gpt-5.6' }), 'openai');
  assert.equal(providerLabelFromConversation({ modelProviderId: 'anthropic' }), 'anthropic');
  assert.equal(
    providerLabelFromConversation({ modelProviderId: 'f5ab0732-a158-4b60-919f-0e319147e183' }),
    undefined,
  );
  assert.equal(providerLabelFromConversation({ model: 'grok-4.5' }), undefined);
  assert.equal(providerLabelFromConversation({}), undefined);
  assert.equal(providerLabelFromConversation(null), undefined);
});

test('resolveConversationModelLabels 通过 listProviders 目录把 UUID 解析成可读标签', () => {
  const providers = [
    {
      id: 'f5ab0732-a158-4b60-919f-0e319147e183',
      groupId: 'xai',
      name: 'xAI',
      model: 'grok-4.5',
      provider: 'xai',
    },
  ];
  const labels = resolveConversationModelLabels(
    {
      modelProviderId: 'f5ab0732-a158-4b60-919f-0e319147e183',
      model: 'f5ab0732-a158-4b60-919f-0e319147e183',
    },
    providers,
  );
  assert.equal(labels.providerLabel, 'xAI');
  assert.equal(labels.modelLabel, 'grok-4.5');
});

test('listTaskOverview 投影 durationMs / modelLabel / providerLabel（目录解析 UUID）', () => {
  const nowMs = Date.now();
  const startedAt = new Date(nowMs - 45_000).toISOString();
  const segmentStart = new Date(nowMs - 15_000).toISOString();
  const providerId = 'f5ab0732-a158-4b60-919f-0e319147e183';
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [
        {
          planId: 'p-live',
          status: 'executing',
          title: '推进中任务',
          updatedAt: new Date(nowMs).toISOString(),
          targetWorkspacePath: '/x/peer_agent',
          conversationId: 'c-live',
          timing: {
            startedAt,
            activeAccumulatedMs: 30_000,
            activeSegmentStartedAt: segmentStart,
          },
          runner: { status: 'running' },
        },
      ],
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [
      {
        id: 'c-live',
        title: '绑定会话',
        workspacePath: '/x/peer_agent',
        updatedAt: new Date(nowMs).toISOString(),
        modelProviderId: providerId,
      },
    ],
    listProviders: () => [
      {
        id: providerId,
        groupId: 'xai',
        name: 'xAI',
        model: 'grok-4.5',
        provider: 'xai',
      },
    ],
  });
  const items = agg.listTaskOverview({ workspacePath: '/x/peer_agent', activeWithinMs: 0 });
  assert.equal(items.length, 1);
  assert.equal(items[0].taskId, 'p-live');
  assert.equal(items[0].modelLabel, 'grok-4.5');
  assert.equal(items[0].providerLabel, 'xAI');
  assert.notEqual(items[0].providerLabel, providerId);
  assert.ok(typeof items[0].durationMs === 'number');
  // 30s 累计 + ~15s open segment ≈ 45s，允许秒级误差
  assert.ok(items[0].durationMs >= 40_000 && items[0].durationMs <= 55_000);
});

test('listTaskOverview 无目录时不把 modelProviderId UUID 投影到卡片', () => {
  const nowMs = Date.now();
  const providerId = 'f5ab0732-a158-4b60-919f-0e319147e183';
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [
        {
          planId: 'p-uuid',
          status: 'executing',
          title: '无目录任务',
          updatedAt: new Date(nowMs).toISOString(),
          targetWorkspacePath: '/x/peer_agent',
          conversationId: 'c-uuid',
          runner: { status: 'running' },
        },
      ],
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [
      {
        id: 'c-uuid',
        title: '绑定会话',
        workspacePath: '/x/peer_agent',
        updatedAt: new Date(nowMs).toISOString(),
        modelProviderId: providerId,
      },
    ],
  });
  const items = agg.listTaskOverview({ workspacePath: '/x/peer_agent', activeWithinMs: 0 });
  assert.equal(items.length, 1);
  assert.equal(items[0].providerLabel, undefined);
  assert.equal(items[0].modelLabel, undefined);
});

test('toGoalPlanSnapshot 缺 planId/status 返回 null', () => {
  assert.equal(toGoalPlanSnapshot({ status: 'executing' }), null);
  assert.equal(toGoalPlanSnapshot({ planId: 'p1' }), null);
  assert.equal(toGoalPlanSnapshot(null), null);
});

test('extractPlanSteps 抽取叶子步骤并标记 current', () => {
  const steps = extractPlanSteps({
    runner: { currentTaskId: 'leaf-2' },
    tasks: [
      {
        taskId: 'group',
        title: '分组',
        status: 'running',
        subtasks: [
          { taskId: 'leaf-1', title: '扩展契约', status: 'completed' },
          { taskId: 'leaf-2', title: '渲染步骤', status: 'running' },
        ],
      },
      { taskId: 'leaf-3', title: '补齐单测', status: 'pending' },
    ],
  });
  assert.deepEqual(steps, [
    { taskId: 'leaf-1', title: '扩展契约', status: 'completed' },
    { taskId: 'leaf-2', title: '渲染步骤', status: 'running', current: true },
    { taskId: 'leaf-3', title: '补齐单测', status: 'pending' },
  ]);
});

test('extractPlanSteps 仅把各叶子任务自己的 Evidence 派生产物挂到对应步骤', () => {
  const steps = extractPlanSteps(
    {
      tasks: [
        { taskId: 'code', title: '代码实现', status: 'completed', evidenceRefs: ['ev-code'] },
        { taskId: 'shot', title: '界面截图', status: 'completed', evidenceRefs: ['ev-shot'] },
        { taskId: 'none', title: '无产物', status: 'pending' },
      ],
    },
    [
      {
        evidenceRef: 'ev-code',
        artifactRefs: ['local-shell-artifact://shell-code/stdout'],
        userArtifacts: [{
          kind: 'code-change',
          ref: 'file:///work/src/app.ts',
          label: '代码变更',
          preview: { kind: 'code', additions: 1, deletions: 1, diffLines: ['--- a/app.ts', '+++ b/app.ts', '-old', '+new'] },
        }],
      },
      {
        evidenceRef: 'ev-shot',
        artifactRefs: ['local-browser-artifact://shot-1/metadata'],
        userArtifacts: [{
          kind: 'image',
          ref: 'local-browser-artifact://shot-1/screenshot',
          label: '界面截图',
          preview: { kind: 'image', dataUrl: 'data:image/png;base64,dGh1bWI=', width: 640, height: 480 },
        }],
      },
    ],
  );
  assert.deepEqual(steps?.[0].artifacts, [
    {
      ref: 'file:///work/src/app.ts',
      kind: 'code',
      label: '代码变更',
      actionLabel: '查看变更',
      preview: { kind: 'code', additions: 1, deletions: 1, diffLines: ['--- a/app.ts', '+++ b/app.ts', '-old', '+new'] },
    },
  ]);
  assert.deepEqual(steps?.[1].artifacts, [
    {
      ref: 'local-browser-artifact://shot-1/screenshot',
      kind: 'image',
      label: '界面截图',
      actionLabel: '预览截图',
      preview: { kind: 'image', dataUrl: 'data:image/png;base64,dGh1bWI=', width: 640, height: 480 },
    },
  ]);
  assert.equal(steps?.[2].artifacts, undefined);
  assert.equal(steps?.[0].artifacts?.some((artifact) => artifact.ref.includes('shot-1')), false);
  assert.doesNotMatch(JSON.stringify(steps?.[0].artifacts), /"label":"(?:shell_|stdout|tool-result)/);
});

test('deriveTaskArtifacts 丢弃错配或越界的 hover preview，但保留用户产物', () => {
  const artifacts = deriveTaskArtifacts(
    ['bad-code', 'bad-image'],
    [
      {
        evidenceRef: 'bad-code',
        userArtifacts: [{
          kind: 'code-change',
          ref: 'file:///work/src/bad.ts',
          preview: { kind: 'image', dataUrl: 'data:image/png;base64,eA==', width: 1, height: 1 },
        }],
      },
      {
        evidenceRef: 'bad-image',
        userArtifacts: [{
          kind: 'image',
          ref: 'local-browser-artifact://bad/screenshot',
          preview: { kind: 'image', dataUrl: 'file:///tmp/secret.png', width: 800, height: 600 },
        }],
      },
    ],
  );
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].preview, undefined);
  assert.equal(artifacts[1].preview, undefined);
});

test('extractPlanSteps 不把没有 artifactRefs 的内部 Evidence 当作用户产物', () => {
  const steps = extractPlanSteps(
    {
      tasks: [
        { taskId: 'internal', title: '内部追溯', status: 'completed', evidenceRefs: ['tool-result://call-secret'] },
      ],
    },
    [{ evidenceRef: 'tool-result://call-secret', artifactRefs: [] }],
  );
  assert.equal(steps?.[0].artifacts, undefined);
});

test('extractPlanSteps caps each task artifact list to keep renderer DOM bounded', () => {
  const evidenceRefs = Array.from({ length: MAX_TASK_OVERVIEW_ARTIFACTS + 12 }, (_, index) => `ev-${index}`);
  const steps = extractPlanSteps(
    {
      tasks: [{ taskId: 'many', title: '大量证据', status: 'completed', evidenceRefs }],
    },
    evidenceRefs.map((evidenceRef, index) => ({
      evidenceRef,
      artifactRefs: [`local-shell-artifact://shell-${index}/stdout`],
      userArtifacts: [{ kind: 'file', ref: `file:///work/result-${index}.txt`, label: `结果文件 ${index + 1}` }],
    })),
  );
  assert.equal(steps?.[0].artifacts?.length, MAX_TASK_OVERVIEW_ARTIFACTS);
});

test('aggregator artifact projection never reads the full EvidenceIndex', () => {
  let requestedRefs = [];
  const plan = {
    planId: 'plan-artifacts',
    conversationId: 'conversation-artifacts',
    title: '有产物的任务',
    status: 'executing',
    updatedAt: '2026-08-16T04:00:00.000Z',
    targetWorkspacePath: '/work/peer_agent',
    runner: { status: 'running', currentTaskId: 'leaf' },
    tasks: [
      {
        taskId: 'leaf',
        title: '生成截图',
        status: 'completed',
        evidenceRefs: ['evidence-shot'],
      },
    ],
  };
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [plan],
      listEvidenceIndex: () => {
        throw new Error('full EvidenceIndex must stay out of taskOverview:list');
      },
      findEvidenceIndexRecords: (refs) => {
        requestedRefs = refs;
        return [
          {
            evidenceRef: 'evidence-shot',
            createdAt: '2026-08-16T04:00:00.000Z',
            artifactRefs: ['local-browser-artifact://shot-1/metadata'],
            userArtifacts: [{
              kind: 'image',
              ref: 'local-browser-artifact://shot-1/screenshot',
              label: '界面截图',
            }],
          },
        ];
      },
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [
      {
        id: 'conversation-artifacts',
        title: '有产物的任务',
        workspacePath: '/work/peer_agent',
        updatedAt: '2026-08-16T04:00:00.000Z',
      },
    ],
  });

  const item = agg.listTaskOverview({ activeWithinMs: 0 })[0];
  assert.deepEqual(requestedRefs, ['evidence-shot']);
  assert.equal(item.planSteps[0].artifacts[0].kind, 'image');
});

test('toGoalPlanSnapshot preserves waiting_user for action-owner projection', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p-waiting',
    status: 'executing',
    title: '等待选择',
    runner: { status: 'waiting_user', blockedReason: 'requested_user_input' },
  });
  assert.equal(snapshot.runnerStatus, 'waiting_user');
});

test('toGoalPlanSnapshot 写入 planSteps', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p-steps',
    status: 'executing',
    title: '推进卡片',
    runner: { status: 'running', currentTaskId: 's2' },
    tasks: [
      { taskId: 's1', title: '协议字段', status: 'completed' },
      { taskId: 's2', title: 'UI 列表', status: 'running' },
    ],
    progress: { completed: 1, total: 2 },
  });
  assert.deepEqual(snapshot.planSteps, [
    { taskId: 's1', title: '协议字段', status: 'completed' },
    { taskId: 's2', title: 'UI 列表', status: 'running', current: true },
  ]);
});

test('toAutomationSnapshot 联合 Definition 与最新 Run', () => {
  const snapshot = toAutomationSnapshot(
    { automationId: 'a1', name: '发布检查', status: 'active', workspacePath: '/x/peer-knowledge' },
    { runId: 'r1', status: 'waiting_permission', updatedAt: '2026-08-07T03:00:00Z' },
  );
  assert.equal(snapshot.automationId, 'a1');
  assert.equal(snapshot.runId, 'r1');
  assert.equal(snapshot.definitionStatus, 'active');
  assert.equal(snapshot.runStatus, 'waiting_permission');
  assert.equal(snapshot.title, '发布检查');
  assert.equal(snapshot.workspaceLabel, 'peer-knowledge');
});

test('toAutomationSnapshot definition 用 id 兜底 automationId', () => {
  const snapshot = toAutomationSnapshot({ id: 'a9', name: 'x', status: 'active' });
  assert.equal(snapshot.automationId, 'a9');
});

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

test('sortTaskOverview 按行动权分组排序', () => {
  const items = [
    { taskId: 't1', actionRight: 'terminal' },
    { taskId: 't2', actionRight: 'peer_advancing' },
    { taskId: 't3', actionRight: 'needs_you' },
    { taskId: 't4', actionRight: 'result_ready' },
    { taskId: 't5', actionRight: 'paused' },
  ];
  const sorted = sortTaskOverview(items);
  assert.deepEqual(
    sorted.map((i) => i.actionRight),
    ['needs_you', 'result_ready', 'peer_advancing', 'paused', 'terminal'],
  );
});

test('sortTaskOverview 同组按最近活跃时间倒序', () => {
  const items = [
    { taskId: 'old', actionRight: 'needs_you', lastActiveAt: '2026-08-01T00:00:00Z' },
    { taskId: 'new', actionRight: 'needs_you', lastActiveAt: '2026-08-07T00:00:00Z' },
  ];
  const sorted = sortTaskOverview(items);
  assert.deepEqual(sorted.map((i) => i.taskId), ['new', 'old']);
});

// ---------------------------------------------------------------------------
// 聚合器端到端
// ---------------------------------------------------------------------------

test('createTaskOverviewAggregator 聚合两 store 并投影', () => {
  const goalPlanStore = {
    listPlanDetails: () => [
      {
        planId: 'p1',
        status: 'awaiting_approval',
        title: '原型实现',
        targetWorkspacePath: '/x/peer_agent',
        progress: { completed: 0, total: 5 },
        updatedAt: '2026-08-07T01:00:00Z',
        conversationId: 'c1',
      },
      {
        planId: 'p2',
        status: 'executing',
        runner: { status: 'running' },
        title: '回归验证',
        originWorkspacePath: '/x/peer_agent',
        progress: { completed: 7, total: 9 },
        updatedAt: '2026-08-07T02:00:00Z',
      },
    ],
  };
  const automationStore = {
    listDefinitions: () => [
      { automationId: 'a1', name: '发布检查', status: 'active', workspacePath: '/x/peer-knowledge' },
    ],
    listRuns: () => [{ runId: 'r1', status: 'waiting_permission', updatedAt: '2026-08-07T03:00:00Z' }],
  };
  const agg = createTaskOverviewAggregator({ goalPlanStore, automationStore });
  // activeWithinMs: 0 关闭时间窗，避免 fixture 日期相对真实 now 过期
  const items = agg.listTaskOverview({ activeWithinMs: 0 });

  assert.equal(items.length, 3);
  // needs_you 两条在前（waiting_permission + awaiting_approval），peer_advancing 在后
  assert.equal(items[0].actionRight, 'needs_you');
  assert.equal(items[1].actionRight, 'needs_you');
  assert.equal(items[2].actionRight, 'peer_advancing');
  // 投影来源正确
  assert.equal(items[0].source, 'automation');
  assert.equal(items[1].source, 'goal_plan');
  // GoalPlan 带 planProgress，Automation 不带
  assert.deepEqual(items[1].planProgress, { completed: 0, total: 5 });
  assert.equal(items[0].planProgress, undefined);
});

test('聚合器对 store 抛错容错（返回空而非崩溃）', () => {
  const goalPlanStore = {
    listPlanDetails: () => {
      throw new Error('store corrupted');
    },
  };
  const automationStore = {
    listDefinitions: () => {
      throw new Error('store corrupted');
    },
    listRuns: () => [],
  };
  const agg = createTaskOverviewAggregator({ goalPlanStore, automationStore });
  assert.deepEqual(agg.listTaskOverview(), []);
});

test('聚合器依赖校验', () => {
  assert.throws(() => createTaskOverviewAggregator({}), TypeError);
  assert.throws(
    () =>
      createTaskOverviewAggregator({
        goalPlanStore: { listPlanDetails: () => [] },
        automationStore: { listDefinitions: () => [] }, // 缺 listRuns
      }),
    TypeError,
  );
});

// ---------------------------------------------------------------------------
// 数据边界：Workspace / 终态 / 活跃窗口 / limit
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-08-08T12:00:00.000Z');
const RECENT = '2026-08-07T12:00:00.000Z'; // 功能上线前 → 存量祖父化
const STALE = '2026-07-01T12:00:00.000Z';
/** 功能上线后的新完成（需一键确认） */
const POST_CUTOFF = '2026-08-08T11:30:00.000Z';

test('isGoalPlanInScope：存量 completed 祖父化排除；上线后未验收进入工作台', () => {
  assert.equal(
    isGoalPlanInScope(
      { planId: 'p', status: 'failed', updatedAt: RECENT, targetWorkspacePath: '/x/peer_agent' },
      { nowMs: NOW },
    ),
    false,
  );
  assert.equal(
    isGoalPlanInScope(
      { planId: 'p', status: 'executing', updatedAt: RECENT, targetWorkspacePath: '/x/peer_agent' },
      { nowMs: NOW },
    ),
    true,
  );
  // 存量（上线前）completed：祖父化为已结束 → 工作台不进
  assert.equal(
    isGoalPlanInScope(
      { planId: 'p', status: 'completed', updatedAt: RECENT, targetWorkspacePath: '/x/peer_agent' },
      { nowMs: NOW },
    ),
    false,
  );
  assert.equal(
    isGoalPlanInScope(
      { planId: 'p', status: 'completed', updatedAt: STALE, targetWorkspacePath: '/x/peer_agent' },
      { nowMs: NOW },
    ),
    false,
  );
  // 上线后未验收 completed → 工作台待验收
  assert.equal(
    isGoalPlanInScope(
      { planId: 'p', status: 'completed', updatedAt: POST_CUTOFF, targetWorkspacePath: '/x/peer_agent' },
      { nowMs: NOW },
    ),
    true,
  );
  // 显式已验收 / 存量：历史 includeTerminal 纳入
  assert.equal(
    isGoalPlanInScope(
      {
        planId: 'p',
        status: 'completed',
        updatedAt: RECENT,
        targetWorkspacePath: '/x/peer_agent',
      },
      { nowMs: NOW, includeTerminal: true },
    ),
    true,
  );
  assert.equal(
    isGoalPlanInScope(
      {
        planId: 'p',
        status: 'completed',
        updatedAt: POST_CUTOFF,
        targetWorkspacePath: '/x/peer_agent',
        resultAcceptance: { acceptedAt: POST_CUTOFF, acceptedBy: 'user' },
      },
      { nowMs: NOW },
    ),
    false,
  );
});

test('workspace overview 使用按工作区读取接口，全局 overview 传入 candidateFilter', () => {
  const calls = [];
  const goalPlanStore = {
    listPlanDetails: (options) => {
      calls.push(['all', typeof options?.candidateFilter]);
      return [];
    },
    listPlanDetailsByWorkspace: (workspacePath, options) => {
      calls.push(['workspace', workspacePath, typeof options?.candidateFilter]);
      return [];
    },
  };
  const agg = createTaskOverviewAggregator({
    goalPlanStore,
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [],
  });

  agg.listTaskOverview({ workspacePath: '/tmp/workspace-a', includeTerminal: false });
  agg.listTaskOverview({ includeTerminal: false });

  assert.deepEqual(calls, [
    ['workspace', '/tmp/workspace-a', 'function'],
    ['all', 'function'],
  ]);
});

test('global TaskOverview candidateFilter skips grandfathered completed before hydrate', () => {
  const hydrated = [];
  const metas = [
    {
      planId: 'old-done',
      status: 'completed',
      title: '存量完成',
      updatedAt: STALE,
      targetWorkspacePath: '/x/peer_agent',
    },
    {
      planId: 'live',
      status: 'executing',
      title: '执行中',
      updatedAt: POST_CUTOFF,
      targetWorkspacePath: '/x/peer_agent',
      runner: { status: 'running' },
    },
  ];
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: ({ candidateFilter } = {}) => metas
        .filter((meta) => !candidateFilter || candidateFilter(meta))
        .map((meta) => {
          hydrated.push(meta.planId);
          return meta;
        }),
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [],
  });

  const items = agg.listTaskOverview({ includeTerminal: false, activeWithinMs: 0 });
  assert.deepEqual(hydrated, ['live']);
  assert.deepEqual(items.map((item) => item.taskId), ['live']);
});

test('isPlanResultAccepted：显式验收与存量祖父化', () => {
  assert.equal(
    isPlanResultAccepted({
      status: 'completed',
      resultAcceptance: { acceptedAt: POST_CUTOFF, acceptedBy: 'user' },
    }),
    true,
  );
  assert.equal(
    isPlanResultAccepted({ status: 'completed', updatedAt: STALE }),
    true,
  );
  assert.equal(
    isPlanResultAccepted({ status: 'completed', updatedAt: RECENT }),
    true,
  );
  assert.equal(
    isPlanResultAccepted({ status: 'completed', updatedAt: POST_CUTOFF }),
    false,
  );
  assert.ok(RESULT_ACCEPTANCE_REQUIRED_SINCE);
  assert.ok(POST_CUTOFF >= RESULT_ACCEPTANCE_REQUIRED_SINCE);
});

test('上线后未验收 completed 投影 result_ready；存量不进工作台', () => {
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [
        {
          planId: 'done-1',
          status: 'completed',
          title: '缓存命中率专项：定位并修复命中率低的问题',
          updatedAt: POST_CUTOFF,
          targetWorkspacePath: '/x/peer_agent',
          conversationId: 'conv-1',
          progress: { completed: 7, total: 7 },
        },
        {
          planId: 'old-done',
          status: 'completed',
          title: '很久以前完成的',
          updatedAt: STALE,
          targetWorkspacePath: '/x/peer_agent',
        },
        {
          planId: 'legacy-recent',
          status: 'completed',
          title: '上线前完成的',
          updatedAt: RECENT,
          targetWorkspacePath: '/x/peer_agent',
        },
        {
          planId: 'accepted-done',
          status: 'completed',
          title: '已确认验收',
          updatedAt: POST_CUTOFF,
          targetWorkspacePath: '/x/peer_agent',
          resultAcceptance: { acceptedAt: POST_CUTOFF, acceptedBy: 'user' },
        },
      ],
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
  });
  const items = agg.listTaskOverview({
    workspacePath: '/x/peer_agent',
    activeWithinMs: 0,
  });
  // 仅上线后未验收一条；存量与已确认不进工作台
  assert.equal(items.length, 1);
  assert.equal(items[0].taskId, 'done-1');
  assert.equal(items[0].actionRight, 'result_ready');
  assert.equal(items[0].title, '缓存命中率专项：定位并修复命中率低的问题');
  assert.equal(items[0].conversationId, 'conv-1');
});

test('上线后 result_ready 不单独限流；存量与已验收进历史 terminal', () => {
  const plans = Array.from({ length: 20 }, (_, i) => ({
    planId: `done-${i}`,
    status: 'completed',
    title: `完成 ${i}`,
    updatedAt: POST_CUTOFF,
    targetWorkspacePath: '/x/peer_agent',
  }));
  plans.push({
    planId: 'legacy-1',
    status: 'completed',
    title: '存量完成',
    updatedAt: STALE,
    targetWorkspacePath: '/x/peer_agent',
  });
  plans.push({
    planId: 'accepted-1',
    status: 'completed',
    title: '已验收',
    updatedAt: POST_CUTOFF,
    targetWorkspacePath: '/x/peer_agent',
    resultAcceptance: { acceptedAt: POST_CUTOFF, acceptedBy: 'user' },
  });
  const agg = createTaskOverviewAggregator({
    goalPlanStore: { listPlanDetails: () => plans },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
  });
  const workbench = agg.listTaskOverview({ workspacePath: '/x/peer_agent', limit: 1000 });
  assert.equal(workbench.length, 20);
  assert.ok(workbench.every((item) => item.actionRight === 'result_ready'));
  assert.ok(!workbench.some((i) => i.taskId === 'legacy-1' || i.taskId === 'accepted-1'));

  const history = agg.listTaskOverview({
    workspacePath: '/x/peer_agent',
    includeTerminal: true,
    activeWithinMs: 0,
    limit: 1000,
  });
  const accepted = history.find((i) => i.taskId === 'accepted-1');
  assert.ok(accepted);
  assert.equal(accepted.actionRight, 'terminal');
  const legacy = history.find((i) => i.taskId === 'legacy-1');
  assert.ok(legacy);
  assert.equal(legacy.actionRight, 'terminal');
});

test('toGoalPlanSnapshot 读取 resultAcceptance → accepted true', () => {
  const snapshot = toGoalPlanSnapshot({
    planId: 'p1',
    status: 'completed',
    title: '已确认',
    resultAcceptance: { acceptedAt: '2026-08-08T12:00:00.000Z', acceptedBy: 'user' },
  });
  assert.equal(snapshot.accepted, true);
});

test('toGoalPlanSnapshot 存量 completed 祖父化 accepted true', () => {
  const legacy = toGoalPlanSnapshot({
    planId: 'legacy',
    status: 'completed',
    title: '旧完成',
    updatedAt: STALE,
  });
  assert.equal(legacy.accepted, true);
  const fresh = toGoalPlanSnapshot({
    planId: 'fresh',
    status: 'completed',
    title: '新完成',
    updatedAt: POST_CUTOFF,
  });
  assert.equal(fresh.accepted, false);
});

test('isGoalPlanInScope 支持 workspace 过滤', () => {
  const plan = {
    planId: 'p',
    status: 'executing',
    updatedAt: RECENT,
    targetWorkspacePath: '/x/peer_agent',
  };
  assert.equal(
    isGoalPlanInScope(plan, { workspacePath: '/x/peer_agent', nowMs: NOW }),
    true,
  );
  assert.equal(
    isGoalPlanInScope(plan, { workspacePath: '/x/other', nowMs: NOW }),
    false,
  );
});

test('跨仓 Goal 按 originWorkspacePath 归属，targetWorkspacePath 仅表示执行仓库', () => {
  const plan = {
    planId: 'cross-workspace',
    status: 'executing',
    title: '跨仓修复工作台',
    updatedAt: RECENT,
    originWorkspacePath: '/x/peer-knowledge',
    targetWorkspacePath: '/x/peer_agent',
  };

  assert.equal(
    isGoalPlanInScope(plan, { workspacePath: '/x/peer-knowledge', nowMs: NOW }),
    true,
  );
  assert.equal(
    isGoalPlanInScope(plan, { workspacePath: '/x/peer_agent', nowMs: NOW }),
    false,
  );

  const snapshot = toGoalPlanSnapshot(plan);
  assert.equal(snapshot.workspaceLabel, 'peer-knowledge');
});

test('isGoalPlanInScope 排除过期活跃窗口', () => {
  assert.equal(
    isGoalPlanInScope(
      { planId: 'p', status: 'executing', updatedAt: STALE, targetWorkspacePath: '/x/peer_agent' },
      { nowMs: NOW, activeWithinMs: 7 * 24 * 60 * 60 * 1000 },
    ),
    false,
  );
});

test('isAutomationInScope 排除终态 run（含 succeeded 方案 A）', () => {
  const def = { automationId: 'a1', status: 'active', workspacePath: '/x/peer_agent' };
  assert.equal(
    isAutomationInScope(def, { runId: 'r', status: 'failed', updatedAt: RECENT }, { nowMs: NOW }),
    false,
  );
  // 方案 A：succeeded 默认不进工作台
  assert.equal(
    isAutomationInScope(def, { runId: 'r', status: 'succeeded', updatedAt: RECENT }, { nowMs: NOW }),
    false,
  );
  assert.equal(
    isAutomationInScope(
      def,
      { runId: 'r', status: 'waiting_permission', updatedAt: RECENT },
      { nowMs: NOW },
    ),
    true,
  );
});

test('listTaskOverview 默认 limit 截断', () => {
  const plans = Array.from({ length: DEFAULT_HOME_LIMIT + 20 }, (_, i) => ({
    planId: `p${i}`,
    status: 'executing',
    title: `t${i}`,
    updatedAt: new Date().toISOString(),
    targetWorkspacePath: '/x/peer_agent',
    runner: { status: 'running' },
    progress: { completed: 1, total: 2 },
  }));
  const agg = createTaskOverviewAggregator({
    goalPlanStore: { listPlanDetails: () => plans },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
  });
  const items = agg.listTaskOverview({ workspacePath: '/x/peer_agent' });
  assert.equal(items.length, DEFAULT_HOME_LIMIT);
});

test('listTaskOverview moves waiting_user GoalPlans out of Peer advancing', () => {
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [{
        planId: 'waiting-choice',
        status: 'executing',
        title: '请选择工作区样式',
        updatedAt: RECENT,
        targetWorkspacePath: '/x/peer_agent',
        conversationId: 'c-waiting',
        runner: { status: 'waiting_user', blockedReason: 'requested_user_input' },
        progress: { completed: 1, total: 1 },
      }],
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
  });
  const [item] = agg.listTaskOverview({ workspacePath: '/x/peer_agent', activeWithinMs: 0 });
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'user_input');
  assert.equal(item.nextAction, 'answer_question');
  assert.equal(item.statusLabel, '等待你的选择');
});

test('listTaskOverview ignores stale waiting_user after plan completion', () => {
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [{
        planId: 'stale-completed-question',
        status: 'completed',
        title: '仍需用户确认',
        updatedAt: POST_CUTOFF,
        targetWorkspacePath: '/x/peer_agent',
        conversationId: 'c-stale-waiting',
        runner: { status: 'waiting_user', blockedReason: 'requested_user_input' },
        progress: { completed: 1, total: 1 },
      }],
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
  });
  const [item] = agg.listTaskOverview({ workspacePath: '/x/peer_agent', activeWithinMs: 0 });
  assert.equal(item.actionRight, 'result_ready');
  assert.equal(item.needsYouReason, undefined);
  assert.equal(item.nextAction, 'review_result');
  assert.equal(item.statusLabel, '待用户验收');
});

test('listTaskOverview 默认排除 failed；上线后 completed 可验收，活跃任务并存', () => {
  const plans = [
    {
      planId: 'old-fail',
      status: 'failed',
      title: '历史失败',
      updatedAt: RECENT,
      targetWorkspacePath: '/x/peer_agent',
      runner: { status: 'blocked' },
    },
    {
      planId: 'done',
      status: 'completed',
      title: '已完成待验收',
      updatedAt: POST_CUTOFF,
      targetWorkspacePath: '/x/peer_agent',
      conversationId: 'c-done',
    },
    {
      planId: 'legacy-done',
      status: 'completed',
      title: '存量完成不进待验收',
      updatedAt: STALE,
      targetWorkspacePath: '/x/peer_agent',
    },
    {
      planId: 'live',
      status: 'awaiting_approval',
      title: '待批准',
      updatedAt: RECENT,
      targetWorkspacePath: '/x/peer_agent',
    },
  ];
  const agg = createTaskOverviewAggregator({
    goalPlanStore: { listPlanDetails: () => plans },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
  });
  const items = agg.listTaskOverview({ workspacePath: '/x/peer_agent', activeWithinMs: 0 });
  assert.equal(items.length, 2);
  assert.equal(items[0].taskId, 'live');
  assert.equal(items[0].actionRight, 'needs_you');
  assert.equal(items[1].taskId, 'done');
  assert.equal(items[1].actionRight, 'result_ready');
  assert.equal(items[1].title, '已完成待验收');
});

test('conversation-scoped TaskOverview never falls back to hydrating every GoalPlan', () => {
  let fullListCalls = 0;
  let conversationListCalls = 0;
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => {
        fullListCalls += 1;
        throw new Error('conversation query must not hydrate the global plan list');
      },
      listPlanDetailsByConversation: (conversationId) => {
        conversationListCalls += 1;
        assert.equal(conversationId, 'conversation-target');
        return [
          {
            planId: 'plan-target',
            conversationId: 'conversation-target',
            status: 'executing',
            title: '目标会话任务',
            updatedAt: RECENT,
            targetWorkspacePath: '/x/peer_agent',
            runner: { status: 'running' },
          },
        ];
      },
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [
      {
        id: 'conversation-target',
        title: '目标会话',
        workspacePath: '/x/peer_agent',
        updatedAt: RECENT,
      },
      {
        id: 'conversation-unrelated',
        title: '无关会话',
        workspacePath: '/x/peer_agent',
        updatedAt: RECENT,
      },
    ],
  });

  const items = agg.listTaskOverview({
    conversationId: 'conversation-target',
    workspacePath: '/x/peer_agent',
    includeTerminal: true,
    activeWithinMs: 0,
  });

  assert.equal(fullListCalls, 0);
  assert.equal(conversationListCalls, 1);
  assert.deepEqual(items.map((item) => item.conversationId), ['conversation-target']);
});

test('workspace-scoped TaskOverview uses the indexed workspace query instead of the global list', () => {
  let fullListCalls = 0;
  let workspaceListCalls = 0;
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => {
        fullListCalls += 1;
        return [];
      },
      listPlanDetailsByWorkspace: (workspacePath) => {
        workspaceListCalls += 1;
        assert.equal(workspacePath, '/x/peer_agent');
        return [];
      },
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [],
  });

  agg.listTaskOverview({ workspacePath: '/x/peer_agent', activeWithinMs: 0 });

  assert.equal(fullListCalls, 0);
  assert.equal(workspaceListCalls, 1);
});

test('listTaskOverview 会补写已完成计划缺失的 qualityReview，并收成 runner 终态', () => {
  const plan = {
    planId: 'plan-stuck-review',
    conversationId: 'conversation-stuck',
    title: '提交质量环与路由',
    status: 'completed',
    accepted: false,
    updatedAt: '2026-08-13T08:28:04.881Z',
    timing: { completedAt: '2026-08-13T08:28:04.881Z' },
    targetWorkspacePath: '/x/peer_agent',
    deliveryBinding: {
      repoId: 'peer_agent',
      targetBranch: 'PeerAgent/0.0.4',
      targetBranchSource: 'workspace_head',
      targetWorkspacePath: '/x/peer_agent',
      boundAt: '2026-08-13T08:13:37.976Z',
    },
    runner: {
      enabled: true,
      status: 'blocked',
      intent: 'verify',
      phase: 'repair',
    },
    progress: { completed: 4, total: 4 },
    tasks: [
      { taskId: 'audit', title: '核对将提交的文件，排除无关改动', status: 'completed' },
      { taskId: 'stage', title: '只暂存本轮质量环和交付路由文件', status: 'completed' },
      { taskId: 'commit', title: '写提交说明并提交', status: 'completed' },
      { taskId: 'verify', title: '确认提交后工作区不再含本轮文件', status: 'completed' },
    ],
  };
  let recordedReview = null;
  let runnerPatch = null;
  const agg = createTaskOverviewAggregator({
    goalPlanStore: {
      listPlanDetails: () => [plan],
      recordQualityReview: (planId, review) => {
        recordedReview = { planId, review };
        plan.qualityReview = review;
        return plan;
      },
      setRunnerState: (planId, patch) => {
        runnerPatch = { planId, patch };
        plan.runner = { ...plan.runner, ...patch };
        return plan;
      },
    },
    automationStore: { listDefinitions: () => [], listRuns: () => [] },
    listConversations: () => [],
  });

  const items = agg.listTaskOverview({ includeTerminal: true, activeWithinMs: 0 });

  assert.equal(recordedReview?.planId, 'plan-stuck-review');
  assert.equal(recordedReview?.review?.status, 'passed');
  assert.equal(runnerPatch?.planId, 'plan-stuck-review');
  assert.equal(runnerPatch?.patch?.status, 'completed');
  assert.equal(items.length, 1);
  assert.equal(items[0].actionRight, 'result_ready');
  assert.equal(items[0].statusLabel, '待用户验收');
  assert.equal(items[0].qualityReviewStatus, 'passed');
});

test('expandGoalThreadRelatives 会补同线已验收祖先', () => {
  const parent = {
    planId: 'root',
    title: '实测 OpenRouter 连通性',
    status: 'completed',
    conversationId: 'conv-or',
    resultAcceptance: { acceptedAt: '2026-08-14T01:00:00.000Z' },
  };
  const child = {
    planId: 'latest',
    title: '对接 OpenRouter 渠道',
    status: 'completed',
    conversationId: 'conv-or',
    parentPlanId: 'root',
    rootPlanId: 'root',
  };
  const expanded = expandGoalThreadRelatives(
    {
      getPlan: (planId) => (planId === 'root' ? parent : null),
      listPlanDetailsByConversation: (conversationId) => (
        conversationId === 'conv-or' ? [parent, child] : []
      ),
    },
    [child],
  );
  assert.deepEqual(expanded.map((plan) => plan.planId).sort(), ['latest', 'root']);
  const relationIndex = buildGoalThreadRelationIndex(expanded);
  const inScopeRoots = new Set(['root']);
  assert.equal(isGoalThreadContextPlan(parent, relationIndex, inScopeRoots), true);
});
