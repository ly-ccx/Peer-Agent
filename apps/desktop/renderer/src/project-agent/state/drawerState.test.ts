import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import {
  briefFromMemories,
  clampDrawerWidth,
  closeDrawer,
  conversationModelLabel,
  drawerLayout,
  drawerStorageKey,
  DRAWER_MAX_WIDTH,
  DRAWER_MIN_WIDTH,
  DRAWER_WIDTH,
  formatDrawerStamp,
  formatDrawerSessionStatus,
  groupDrawerSessions,
  locateDrawerSession,
  openDrawer,
  readDrawerMemory,
  readDrawerSession,
  filterMemoryRecords,
  readMemoryItems,
  readMemoryRecords,
  readMemorySwitches,
  resizeDrawer,
  writeDrawerMemory,
  type DrawerMemory,
  type DrawerSession,
  type DrawerStore,
} from './drawerState.ts';

function memoryStore(): DrawerStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value);
    },
  };
}

function session(partial: Partial<DrawerSession> & Pick<DrawerSession, 'sessionId' | 'status'>): DrawerSession {
  return {
    title: partial.sessionId,
    statusLabel: '',
    spawnedAt: '',
    conversationId: '',
    anchorMessageId: '',
    modelLabel: '',
    summary: '',
    evidenceRefs: [],
    progress: '',
    ...partial,
  };
}

test('会话事实里的 cancelable 必须原样带到抽屉，缺字段时不伪造', () => {
  const blocked = readDrawerSession({ sessionId: 's-cancel', status: 'running', statusLabel: 'Peer 正在推进', cancelable: false });
  assert.ok(blocked);
  assert.equal(blocked.cancelable, false);
  const legacy = readDrawerSession({ sessionId: 's-legacy', status: 'running', statusLabel: 'Peer 正在推进' });
  assert.ok(legacy);
  assert.equal(legacy.cancelable, undefined);
});

test('缺失前置任务没有 blocker 行时仍显示需要重新安排的原因', () => {
  const missing = readDrawerSession({ sessionId: 'blocked', status: 'waiting_user', statusLabel: '等待你',
    queueReason: 'dependency_missing', queuedBehind: [] });
  assert.ok(missing);
  assert.equal(formatDrawerSessionStatus(missing, createI18n('zh-CN')), '前置任务已缺失，请重新安排');
  assert.equal(formatDrawerSessionStatus(missing, createI18n('en-US')), 'Dependency is missing; please replan');
  const i18n = createI18n('zh-CN');
  assert.equal(formatDrawerSessionStatus(session({ sessionId: 'normal', status: 'running', statusLabel: '进行中' }), i18n), '进行中');
  assert.equal(formatDrawerSessionStatus(session({ sessionId: 'failed', status: 'waiting_user', queueReason: 'dependency_failed',
    queuedBehind: [{ sessionId: 'dep', title: '检查' }] }), i18n), '前置任务需要处理：检查');
  assert.equal(formatDrawerSessionStatus(session({ sessionId: 'queued', status: 'queued', queueReason: 'write_slot',
    queuedBehind: [{ sessionId: 'dep', title: '修改' }] }), i18n), '等待 修改');
});

test('打开与任务定位只作用于当前界面，重新进入机器人只恢复页签', () => {
  const closed: DrawerMemory = { open: false, tab: 'overview', sessionId: null };
  const opened = openDrawer(closed, 'memory');
  assert.deepEqual(opened, { open: true, tab: 'memory', sessionId: null });
  const located = locateDrawerSession(opened, 'sess-1');
  assert.deepEqual(located, { open: true, tab: 'tasks', sessionId: 'sess-1' });
  const store = memoryStore();
  writeDrawerMemory('ws-1', located, store);
  assert.deepEqual(readDrawerMemory('ws-1', store), { open: false, tab: 'tasks', sessionId: null });
  assert.deepEqual(JSON.parse(store.get(drawerStorageKey('ws-1'))!), { tab: 'tasks' });
  assert.deepEqual(readDrawerMemory('ws-2', store), closed);
  writeDrawerMemory('ws-1', closeDrawer(located), store);
  assert.equal(readDrawerMemory('ws-1', store).open, false);
  assert.equal(readDrawerMemory('ws-1', store).sessionId, null);
});

test('旧版展开与定位记录不会自动打开设置，页签和宽度仍保留', () => {
  const store = memoryStore();
  store.set(drawerStorageKey('ws-legacy'), JSON.stringify({
    open: true, tab: 'settings', width: 460, sessionId: 'old-session', objectiveId: 'old-objective',
  }));
  const restored = readDrawerMemory('ws-legacy', store);
  assert.deepEqual(restored, { open: false, tab: 'settings', sessionId: null, width: 460 });
  assert.deepEqual(openDrawer(restored), { open: true, tab: 'settings', sessionId: null, width: 460 });
});

test('宽窗口推开对话，窄窗口覆盖', () => {
  assert.equal(drawerLayout(960), 'push');
  assert.equal(drawerLayout(1200), 'push');
  assert.equal(drawerLayout(959), 'cover');
});

test('任务按需要你、进行中、排队、已完成分组', () => {
  const groups = groupDrawerSessions([
    session({ sessionId: 'need', status: 'waiting_user' }),
    session({ sessionId: 'confirm', status: 'result_ready' }),
    session({ sessionId: 'run', status: 'running' }),
    session({ sessionId: 'start', status: 'starting' }),
    session({ sessionId: 'queue', status: 'queued' }),
    session({ sessionId: 'done', status: 'accepted' }),
    session({ sessionId: 'fail', status: 'failed' }),
  ]);
  assert.deepEqual(groups.needsYou.map((item) => item.sessionId), ['need', 'confirm']);
  assert.deepEqual(groups.running.map((item) => item.sessionId), ['run', 'start']);
  assert.deepEqual(groups.queued.map((item) => item.sessionId), ['queue']);
  assert.deepEqual(groups.done.map((item) => item.sessionId), ['done', 'fail']);
});

test('任务详情读出锚点、冻结模型和证据', () => {
  const detail = readDrawerSession({
    sessionId: 'sess-1',
    title: '发布说明',
    status: 'running',
    statusLabel: '正在写',
    spawnedAt: '2026-09-27T01:00:00.000Z',
    conversationId: 'child-1',
    origin: {
      anchorMessageId: 'user-1',
      modelSelection: { worker: { modelId: 'writer-1', modelProviderId: 'local/writer' } },
    },
    report: { summary: '说明已写好', evidenceRefs: ['evidence:1'] },
  });
  assert.equal(detail?.conversationId, 'child-1');
  assert.equal(detail?.anchorMessageId, 'user-1');
  assert.equal(detail?.modelLabel, 'writer-1');
  assert.equal(detail?.summary, '说明已写好');
  assert.deepEqual(detail?.evidenceRefs, ['evidence:1']);
  assert.equal(readDrawerSession({ title: '没有 id' }), null);
});

test('档案时间不展示原始 ISO', () => {
  const now = new Date(2026, 8, 30, 9, 40).getTime();
  assert.equal(formatDrawerStamp(new Date(2026, 8, 30, 9, 40, 37).toISOString(), now), '09:40');
  assert.equal(formatDrawerStamp(new Date(2026, 8, 25, 15, 40, 37).toISOString(), now), '9/25 15:40');
  assert.equal(formatDrawerStamp(new Date(2025, 10, 2, 3, 52, 19).toISOString(), now), '2025/11/2 03:52');
  assert.equal(formatDrawerStamp('not-a-time', now), '');
});

test('任务说明使用 taskBrief，不能把工作报告正文重新命名为说明', () => {
  const detail = readDrawerSession({ sessionId: 's', report: {
    summary: '实际报告：发现了三项结果', taskBrief: '只读调查仓库',
    contentSource: { kind: 'worker_message', verification: 'unverified' },
  } });
  assert.equal(detail?.summary, '只读调查仓库');
  const missing = readDrawerSession({ sessionId: 's', report: {
    summary: '实际报告', contentSource: { kind: 'worker_message', verification: 'unverified' },
  } });
  assert.equal(missing?.summary, '');
});

test('记忆只读投影和对话模型标签', () => {
  const items = readMemoryItems([
    { id: 'm1', kind: 'responsibility', text: '这个项目负责发布说明', status: 'active' },
    { id: 'm2', kind: 'fact', text: '已忘记', status: 'forgotten' },
    { id: '', text: '没有 id' },
  ]);
  assert.deepEqual(items, [{
    id: 'm1',
    kind: 'responsibility',
    text: '这个项目负责发布说明',
    trust: 'stated',
    status: 'active',
    pinned: false,
  }]);
  assert.equal(briefFromMemories(items), '这个项目负责发布说明');
  const records = readMemoryRecords([
    { id: 'm1', kind: 'fact', text: '最近的事实', trust: 'verified', status: 'active', pinned: true },
    { id: 'm2', kind: 'fact', text: '已撤销', trust: 'stated', status: 'forgotten', pinned: false },
  ]);
  assert.equal(records.length, 2);
  assert.deepEqual(filterMemoryRecords(records, { kind: 'fact', trust: 'verified', status: 'active' }).map((item) => item.id), ['m1']);
  assert.deepEqual(readMemorySwitches({ memoryEnabled: false, useMemory: true }), {
    memoryEnabled: false,
    useMemory: true,
    learnPreferences: true,
  });
  assert.equal(conversationModelLabel({
    resolutions: [{ role: 'session_worker', label: '工人' }, { role: 'project_agent', label: '对话模型' }],
  }), '对话模型');
});

test('queue reasons use host blockers and tolerate malformed older responses', () => {
  const session=readDrawerSession({sessionId:'s',status:'queued',queueReason:'write_slot',queuedBehind:[null,{sessionId:'a',title:'写入任务'},{title:'bad'}]});
  assert.deepEqual(session?.queuedBehind,[{sessionId:'a',title:'写入任务'}]);assert.equal(session?.queueReason,'write_slot');
  assert.deepEqual(readDrawerSession({sessionId:'old'})?.queuedBehind,[]);
});

test('isolation failures and disk waits have readable labels even without a blocking session', () => {
  const i18n = createI18n('zh-CN');
  for (const reason of ['disk_space', 'isolation_failed']) {
    const session = readDrawerSession({ sessionId: 's', status: 'queued', queueReason: reason });
    assert.ok(session);
    const label = formatDrawerSessionStatus(session, i18n);
    assert.match(label, reason === 'disk_space' ? /磁盘/ : /隔离/);
    assert.doesNotMatch(label, /disk_space|isolation_failed/);
  }
});

test('paused and superseded tasks stay separate from done and carry a replacement relation', () => {
  const item = readDrawerSession({ sessionId: 'a', title: 'A', status: 'superseded', supersededBy: 'b' });
  assert.equal(item?.supersededBy, 'b');
  const groups = groupDrawerSessions([item!, session({ sessionId: 'p', status: 'paused' })]);
  assert.equal(groups.paused.length, 2); assert.equal(groups.done.length, 0); assert.equal(groups.queued.length, 0);
});

test('memory page retains maintenance state and sources while overview only uses effective records', () => {
  const records=readMemoryRecords([{id:'fresh',kind:'fact',text:'current',trust:'verified',status:'active',sourceRefs:['ev']},{id:'stale',kind:'fact',text:'old',trust:'verified',status:'active',needsReverify:true,sourceRefs:['ev-old']},{id:'conflict',kind:'fact',text:'alternative',trust:'verified',status:'conflicted'}]);
  assert.equal(records[1].needsReverify,true);assert.deepEqual(records[1].sourceRefs,['ev-old']);
  assert.deepEqual(readMemoryItems(records).map(item=>item.id),['fresh']);
  assert.equal(filterMemoryRecords(records,{kind:'',trust:'',status:'conflicted'}).length,1);
});

test('task origin retains objective navigation while drawer preferences do not persist the active target',()=>{
  assert.equal(readDrawerSession({sessionId:'s',status:'running',origin:{objectiveId:'objective-x'}})?.objectiveId,'objective-x');
  const store=memoryStore();writeDrawerMemory('w',{open:true,tab:'objectives',sessionId:null,objectiveId:'objective-x'},store);
  assert.equal(readDrawerMemory('w',store).objectiveId,undefined);
  assert.equal(readDrawerMemory('w',store).tab,'objectives');
});

test('drawer width clamps to its bounds and rejects non-finite input', () => {
  assert.equal(clampDrawerWidth(DRAWER_MIN_WIDTH - 100), DRAWER_MIN_WIDTH);
  assert.equal(clampDrawerWidth(DRAWER_MAX_WIDTH + 100), DRAWER_MAX_WIDTH);
  assert.equal(clampDrawerWidth(400), 400);
  assert.equal(clampDrawerWidth(400.6), 401);
  assert.equal(clampDrawerWidth(Number.NaN), DRAWER_WIDTH);
  assert.equal(clampDrawerWidth(Number.POSITIVE_INFINITY), DRAWER_WIDTH);
});

test('resizeDrawer keeps memory intact and only writes a legal width', () => {
  const base: DrawerMemory = { open: true, tab: 'settings', sessionId: 's-1' };
  const widened = resizeDrawer(base, DRAWER_MAX_WIDTH + 999);
  assert.equal(widened.width, DRAWER_MAX_WIDTH);
  assert.equal(widened.open, true);
  assert.equal(widened.tab, 'settings');
  assert.equal(widened.sessionId, 's-1');
  // 非法输入不改动原对象，避免把 NaN 写进持久化。
  assert.equal(resizeDrawer(base, Number.NaN), base);
});

test('persisted drawer width survives a round trip and is re-clamped on read', () => {
  const store = memoryStore();
  writeDrawerMemory('w', { open: true, tab: 'settings', sessionId: null, width: 460 }, store);
  assert.equal(readDrawerMemory('w', store).width, 460);
  // 旧数据被外部改坏（越界 / 非数字）时，读回必须收敛到合法区间。
  store.set(drawerStorageKey('w'), JSON.stringify({ open: true, tab: 'settings', sessionId: null, width: 9999 }));
  assert.equal(readDrawerMemory('w', store).width, DRAWER_MAX_WIDTH);
  store.set(drawerStorageKey('w'), JSON.stringify({ open: true, tab: 'settings', sessionId: null, width: 'wide' }));
  assert.equal(readDrawerMemory('w', store).width, undefined);
});

test('drawer memory without a width never fabricates one', () => {
  const store = memoryStore();
  writeDrawerMemory('w', { open: true, tab: 'overview', sessionId: null }, store);
  assert.equal(readDrawerMemory('w', store).width, undefined);
});
