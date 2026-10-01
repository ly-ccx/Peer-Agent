import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import {
  briefFromMemories,
  closeDrawer,
  conversationModelLabel,
  drawerLayout,
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

test('打开、定位，并按机器人记住抽屉', () => {
  const closed: DrawerMemory = { open: false, tab: 'overview', sessionId: null };
  const opened = openDrawer(closed, 'memory');
  assert.deepEqual(opened, { open: true, tab: 'memory', sessionId: null });
  const located = locateDrawerSession(opened, 'sess-1');
  assert.deepEqual(located, { open: true, tab: 'tasks', sessionId: 'sess-1' });
  const store = memoryStore();
  writeDrawerMemory('ws-1', located, store);
  assert.deepEqual(readDrawerMemory('ws-1', store), located);
  assert.deepEqual(readDrawerMemory('ws-2', store), closed);
  writeDrawerMemory('ws-1', closeDrawer(located), store);
  assert.equal(readDrawerMemory('ws-1', store).open, false);
  assert.equal(readDrawerMemory('ws-1', store).sessionId, 'sess-1');
});

test('宽窗口推开对话，窄窗口覆盖', () => {
  assert.equal(drawerLayout(960), 'push');
  assert.equal(drawerLayout(1200), 'push');
  assert.equal(drawerLayout(959), 'cover');
});

test('任务按需要你、进行中、排队、已完成分组', () => {
  const groups = groupDrawerSessions([
    session({ sessionId: 'need', status: 'waiting_user' }),
    session({ sessionId: 'run', status: 'running' }),
    session({ sessionId: 'start', status: 'starting' }),
    session({ sessionId: 'queue', status: 'queued' }),
    session({ sessionId: 'done', status: 'accepted' }),
    session({ sessionId: 'fail', status: 'failed' }),
  ]);
  assert.deepEqual(groups.needsYou.map((item) => item.sessionId), ['need']);
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
