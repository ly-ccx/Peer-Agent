import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotListItem } from '@peer-agent/protocol';
import type { DrawerSession } from './drawerState.ts';
import {
  canGoBack,
  canGoForward,
  currentNavigationView,
  historyTotalOf,
  initialNavigationState,
  isSessionInCurrentList,
  navigateBack,
  navigateForward,
  navigateTo,
  pruneDeletedWorkspace,
  recencyBucketOf,
  sidebarActiveSessionsOf,
  summarizeActiveSessions,
  toggleBotExpanded,
  toggleBotMoreTasks,
  toggleSidebarCollapsed,
} from './botNavigationState.ts';

function makeBotItem(overrides: Partial<BotListItem> = {}): BotListItem {
  return {
    workspaceId: 'ws-a',
    profile: {
      workspaceId: 'ws-a',
      displayName: 'Peer-Agent',
      avatar: { kind: 'generated', shape: 'circle', color: 'blue' },
      agentConversationId: 'conv-a',
      updatedAt: '2026-11-23T10:00:00.000Z',
    },
    state: { unread: 0, needsYou: 0, running: 0 },
    preview: '',
    lastActiveAt: '2026-11-23T10:00:00.000Z',
    activeSessions: [],
    activeSessionTotal: 0,
    historySessionTotal: 0,
    ...overrides,
  };
}

function makeDrawerSession(overrides: Partial<DrawerSession> = {}): DrawerSession {
  return {
    sessionId: 'sess-1',
    title: 'Fix verifier gitconfig',
    status: 'running',
    statusLabel: '执行中',
    summary: '',
    spawnedAt: '2026-11-23T10:00:00.000Z',
    conversationId: 'conv-child-1',
    anchorMessageId: 'msg-1',
    modelLabel: 'gpt-5',
    progress: '',
    evidenceRefs: [],
    ...overrides,
  };
}

test('导航栈支持 Bot 与 Full-Width Task 双向回溯、分支截断与删除剪枝', () => {
  let state = initialNavigationState('ws-a');
  assert.deepEqual(currentNavigationView(state), { kind: 'bot', workspaceId: 'ws-a' });
  assert.equal(canGoBack(state), false);
  assert.equal(canGoForward(state), false);

  state = navigateTo(state, { kind: 'task', workspaceId: 'ws-a', sessionId: 's1' });
  state = navigateTo(state, { kind: 'bot', workspaceId: 'ws-b' });
  assert.equal(canGoBack(state), true);
  assert.equal(canGoForward(state), false);
  assert.equal(state.expandedBots['ws-b'], true);

  // Duplicate navigation is idempotent
  const dup = navigateTo(state, { kind: 'bot', workspaceId: 'ws-b' });
  assert.equal(dup.stack.length, 3);

  // Back -> task s1 -> forward -> ws-b
  state = navigateBack(state);
  assert.deepEqual(currentNavigationView(state), { kind: 'task', workspaceId: 'ws-a', sessionId: 's1' });
  assert.equal(canGoForward(state), true);
  state = navigateForward(state);
  assert.deepEqual(currentNavigationView(state), { kind: 'bot', workspaceId: 'ws-b' });

  // Branching from middle truncates forward history
  state = navigateBack(state);
  state = navigateTo(state, { kind: 'task', workspaceId: 'ws-a', sessionId: 's2' });
  assert.equal(canGoForward(state), false);
  assert.equal(state.stack.length, 3);

  // Pruning deleted workspace adjusts index and removes expand flags
  state = toggleBotMoreTasks(state, 'ws-a');
  const pruned = pruneDeletedWorkspace(state, 'ws-a');
  assert.equal(pruned.stack.length, 0);
  assert.equal(currentNavigationView(pruned), null);
  assert.equal(pruned.expandedBots['ws-a'], undefined);
  assert.equal(pruned.expandedMoreBots['ws-a'], undefined);

  // Toggles
  let toggled = toggleBotExpanded(initialNavigationState('ws-a'), 'ws-a');
  assert.equal(toggled.expandedBots['ws-a'], false);
  toggled = toggleSidebarCollapsed(toggled);
  assert.equal(toggled.sidebarCollapsed, true);
});

test('ADR 110 / 124：唯一消费宿主 followUp.inCurrentList 并隐藏 obligation_indexed', () => {
  assert.equal(isSessionInCurrentList('running', { inCurrentList: true, owner: 'bot', reason: 'live_execution' }), true);
  assert.equal(isSessionInCurrentList('result_ready', { inCurrentList: true, owner: 'bot', reason: 'verification_failed' }), true);
  assert.equal(isSessionInCurrentList('accepted', { inCurrentList: false, owner: 'none', reason: 'settled' }), false);
  assert.equal(isSessionInCurrentList('running', { inCurrentList: false, owner: 'none', reason: 'obligation_indexed' }), null);
});

test('侧栏活跃任务优先使用实时 work.sessions 并按关注度排序，同时过滤 obligation_indexed', () => {
  const bot = makeBotItem({
    activeSessions: [
      {
        sessionId: 'catalog-only',
        title: 'Catalog Task',
        status: 'running',
        updatedAt: '2026-11-23T09:00:00.000Z',
        followUp: { inCurrentList: true, owner: 'bot', reason: 'live_execution' },
      },
    ],
    activeSessionTotal: 4,
    historySessionTotal: 7,
  });

  // Non-opened bot falls back cleanly to catalog projection
  const fromCatalog = sidebarActiveSessionsOf(bot, null);
  assert.equal(fromCatalog.items.length, 1);
  assert.equal(fromCatalog.total, 4);
  assert.equal(historyTotalOf(bot, null), 7);

  // Opened bot prefers live sessions & orders waiting_user -> verification_failed -> running
  const live: DrawerSession[] = [
    makeDrawerSession({ sessionId: 'run-1', title: 'Running', status: 'running', followUp: { inCurrentList: true, owner: 'bot', reason: 'live_execution' } }),
    makeDrawerSession({ sessionId: 'obl-1', title: 'Hidden Obligation', status: 'running', followUp: { inCurrentList: false, owner: 'none', reason: 'obligation_indexed' } }),
    makeDrawerSession({ sessionId: 'vf-1', title: 'Verify Failed', status: 'result_ready', followUp: { inCurrentList: true, owner: 'bot', reason: 'verification_failed' } }),
    makeDrawerSession({ sessionId: 'usr-1', title: 'Needs Approval', status: 'waiting_user', followUp: { inCurrentList: true, owner: 'user', reason: 'human_request' } }),
    makeDrawerSession({ sessionId: 'done-1', title: 'Done', status: 'accepted', followUp: { inCurrentList: false, owner: 'none', reason: 'settled' } }),
  ];

  const fromLive = sidebarActiveSessionsOf(bot, live);
  assert.deepEqual(fromLive.items.map(s => s.sessionId), ['usr-1', 'vf-1', 'run-1']);
  assert.equal(fromLive.total, 3);
});

test('Touch Bar 活跃摘要与历史时间分组行为准确', () => {
  const idle = summarizeActiveSessions([], true);
  assert.equal(idle.leadTone, 'idle');
  assert.equal(idle.total, 0);

  const mixed = summarizeActiveSessions([
    { status: 'waiting_user', followUp: { inCurrentList: true, owner: 'user', reason: 'human_request' } },
    { status: 'result_ready', followUp: { inCurrentList: true, owner: 'bot', reason: 'verification_failed' } },
    { status: 'running', followUp: { inCurrentList: true, owner: 'bot', reason: 'live_execution' } },
  ], true);
  assert.equal(mixed.total, 3);
  assert.equal(mixed.leadTone, 'warn');
  assert.deepEqual(mixed.segments, ['待你决定 1', '核验未通过 1']);

  const now = Date.parse('2026-11-23T12:00:00.000Z');
  assert.equal(recencyBucketOf('2026-11-23T08:00:00.000Z', now), 'today');
  assert.equal(recencyBucketOf('2026-11-20T08:00:00.000Z', now), 'week');
  assert.equal(recencyBucketOf('2026-11-01T08:00:00.000Z', now), 'earlier');
  assert.equal(recencyBucketOf('not-a-date', now), 'earlier');
});
