import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PREPARED_BROWSER_CONVERSATIONS,
  mountedBrowserConversations,
  rememberLeavingBrowserConversation,
  rememberPreparedBrowser,
  resolveBrowserPanelReveal,
  stabilizeMountedBrowserOrder,
} from './browserPanelReveal.ts';
test('foreground focus still opens the current conversation Browser panel', () => {
  const decision = resolveBrowserPanelReveal({
    requestConversationId: 'conversation-a',
    hostConversationId: 'conversation-a',
    layoutHost: 'root',
    focus: true,
    hostOpen: false,
    hostBrowserActive: false,
    requestSessionExists: false,
  });
  assert.deepEqual(decision, {
    accept: true,
    stealUi: true,
    prepareSession: true,
    mountPrepared: true,
    status: 'opened',
  });
});

test('background Task can prepare another conversation without stealing the workbench', () => {
  const decision = resolveBrowserPanelReveal({
    requestConversationId: 'conversation-b',
    hostConversationId: 'conversation-a',
    layoutHost: 'root',
    focus: true,
    hostOpen: true,
    hostBrowserActive: true,
    requestSessionExists: false,
  });
  assert.deepEqual(decision, {
    accept: true,
    stealUi: false,
    prepareSession: true,
    mountPrepared: true,
    status: 'opened',
  });
});

test('background Task does not need the user to already be on that conversation', () => {
  const decision = resolveBrowserPanelReveal({
    requestConversationId: 'conversation-b',
    hostConversationId: 'conversation-a',
    layoutHost: 'root',
    focus: false,
    hostOpen: false,
    hostBrowserActive: false,
    requestSessionExists: true,
  });
  assert.equal(decision.accept, true);
  assert.equal(decision.stealUi, false);
  assert.equal(decision.mountPrepared, true);
  assert.equal(decision.status, 'already_active');
});

test('nested drawer workbench does not consume global Browser reveal', () => {
  const decision = resolveBrowserPanelReveal({
    requestConversationId: 'conversation-a',
    hostConversationId: 'conversation-a',
    layoutHost: 'local',
    focus: true,
    hostOpen: true,
    hostBrowserActive: false,
    requestSessionExists: true,
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.error, 'not_reveal_host');
});

test('rememberPreparedBrowser keeps the newest conversations within the cap', () => {
  const ids = rememberPreparedBrowser(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    'i',
  );
  assert.deepEqual(ids, ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.deepEqual(rememberPreparedBrowser(ids, 'c'), ['b', 'd', 'e', 'f', 'g', 'h', 'i', 'c']);
});

test('rememberLeavingBrowserConversation keeps a used page and skips blank about:blank', () => {
  assert.deepEqual(
    rememberLeavingBrowserConversation(['kept'], 'leaving', false),
    ['kept', 'leaving'],
  );
  assert.deepEqual(
    rememberLeavingBrowserConversation(['kept'], 'blank-session', true),
    ['kept'],
  );
});

test('mountedBrowserConversations keeps the current session in the same live list', () => {
  assert.deepEqual(
    mountedBrowserConversations('current', ['old-a', 'old-b']),
    ['old-a', 'old-b', 'current'],
  );
  const overCap = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.equal(MAX_PREPARED_BROWSER_CONVERSATIONS, 8);
  assert.deepEqual(
    mountedBrowserConversations('i', overCap),
    ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
  );
});

test('switch away and back keeps the visited session alive (local layout keep-alive)', () => {
  // 模拟 local 布局：在会话 A 里打开页面后切到 B，再切回 A。
  // 关键不变量：A 作为"被切走的非空白会话"必须始终留在 mounted 名单里，
  // 这样 local 布局渲染多个常驻 BrowserView 时 A 的 key 稳定，guest 不重建、不重载。
  let prepared: string[] = [];

  // A 打开页面后切走：A 非空白(false) -> 记进活页名单。
  prepared = rememberLeavingBrowserConversation(prepared, 'A', false);
  assert.deepEqual(prepared, ['A']);

  // 切到 B：A 仍在名单，B 成为当前会话。
  const afterSwitchToB = mountedBrowserConversations('B', prepared);
  assert.ok(afterSwitchToB.includes('A'), 'A 应保活在名单中，BrowserView 常驻');
  assert.deepEqual(afterSwitchToB, ['A', 'B']);

  // 切回 A：A 仍在名单。LRU 会把当前会话挪到末尾，所以集合顺序会变；
  // 真正给 React key 用的顺序必须再走 stabilizeMountedBrowserOrder。
  const afterSwitchBackToA = mountedBrowserConversations('A', afterSwitchToB);
  assert.ok(afterSwitchBackToA.includes('A'), '切回 A 时 A 仍常驻，不重建');
  assert.deepEqual(afterSwitchBackToA, ['B', 'A']);
});

test('stabilizeMountedBrowserOrder keeps host order when switching away and back', () => {
  let prepared: string[] = [];
  let order: string[] = [];

  const mount = (current: string, nextPrepared: readonly string[]) => {
    prepared = [...nextPrepared];
    const nextIds = mountedBrowserConversations(current, prepared);
    order = stabilizeMountedBrowserOrder(order, nextIds);
    return order;
  };

  // 前台 A 先挂上。
  assert.deepEqual(mount('A', []), ['A']);

  // 切到 B：A 非空白入活页，B 追加在后面，A 的宿主下标不变。
  prepared = rememberLeavingBrowserConversation(prepared, 'A', false);
  assert.deepEqual(mount('B', prepared), ['A', 'B']);

  // 切回 A：LRU 名单变成 ['B','A']，稳定顺序仍是 ['A','B']。
  prepared = rememberLeavingBrowserConversation(prepared, 'B', true);
  assert.deepEqual(mount('A', prepared), ['A', 'B']);
  assert.deepEqual(
    stabilizeMountedBrowserOrder(['A', 'B'], mountedBrowserConversations('A', prepared)),
    ['A', 'B'],
  );
});

test('stabilizeMountedBrowserOrder only appends newcomers and drops evictions', () => {
  assert.deepEqual(
    stabilizeMountedBrowserOrder(['A'], ['B', 'A']),
    ['A', 'B'],
  );
  assert.deepEqual(
    stabilizeMountedBrowserOrder(['A', 'B'], ['B', 'A']),
    ['A', 'B'],
  );
  assert.deepEqual(
    stabilizeMountedBrowserOrder(['A', 'B', 'C'], ['B', 'C', 'D']),
    ['B', 'C', 'D'],
  );
});

test('Strict Mode double-render still remembers the leaving non-blank session', () => {
  // 复刻 WorkbenchProvider 的「render 当帧记离场」：同一组 props/state 被调用两次
  // 时，必须都看到同一个 previousConversationId，不能靠可变 ref。
  const prepared: string[] = [];
  const trackedConversationId = 'A';
  const conversationId = 'B';

  const planLive = (previousId: string, currentId: string, ids: readonly string[]) => {
    if (previousId === currentId) return [...ids];
    return rememberLeavingBrowserConversation(ids, previousId, false);
  };

  const first = planLive(trackedConversationId, conversationId, prepared);
  const second = planLive(trackedConversationId, conversationId, prepared);
  assert.deepEqual(first, ['A']);
  assert.deepEqual(second, ['A']);

  // 反例：若第一次 render 就改掉 previous ref，第二次会丢掉 A。
  let previousRef = 'A';
  const buggyPlan = () => {
    if (previousRef === conversationId) return [...prepared];
    const leavingId = previousRef;
    previousRef = conversationId;
    return rememberLeavingBrowserConversation(prepared, leavingId, false);
  };
  assert.deepEqual(buggyPlan(), ['A']);
  assert.deepEqual(buggyPlan(), []);
});
