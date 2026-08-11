import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTaskOverviewAggregator,
  currentStepTitleFromItem,
  displayConversationTitle,
  extractPlanSteps,
  looksLikeOpaqueId,
  modelLabelFromConversation,
  providerLabelFromConversation,
  resolveConversationModelLabels,
  sortTaskOverview,
  toAutomationSnapshot,
  toGoalPlanSnapshot,
  isGoalPlanInScope,
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

test('aggregator omits read conversations from 正在讨论 projection', () => {
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
  assert.equal(items.length, 1);
  assert.equal(items[0].conversationId, 'conversation-unread');
  assert.equal(items[0].statusLabel, '有未读');
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

test('workspace overview 使用按工作区读取接口，全局 overview 保持全量读取', () => {
  const calls = [];
  const goalPlanStore = {
    listPlanDetails: () => {
      calls.push(['all']);
      return [];
    },
    listPlanDetailsByWorkspace: (workspacePath) => {
      calls.push(['workspace', workspacePath]);
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
    ['workspace', '/tmp/workspace-a'],
    ['all'],
  ]);
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
    updatedAt: RECENT,
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

test('listTaskOverview keeps stale completed + waiting_user in needs_you', () => {
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
  assert.equal(item.actionRight, 'needs_you');
  assert.equal(item.needsYouReason, 'user_input');
  assert.equal(item.nextAction, 'answer_question');
  assert.equal(item.statusLabel, '等待你的选择');
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
