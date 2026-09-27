import assert from 'node:assert/strict';
import test from 'node:test';
import type { BotListItem } from '@peer-agent/protocol';
import {
  applyBotRefresh,
  clampBotListWidth,
  enterBotSelection,
  formatBotListTime,
  mergeBotSearch,
  moveBotSelection,
  readBotListWidth,
  retainSelectedId,
  sumNeedsYou,
  validateManagedBotName,
  visibleBotList,
} from './botListState.ts';

function bot(id: string, at: string, extra: Partial<BotListItem['state']> & { name?: string; preview?: string } = {}): BotListItem {
  return {
    workspaceId: id,
    profile: {
      workspaceId: id,
      displayName: extra.name ?? id,
      avatar: { kind: 'generated', shape: 'circle', color: '#2563eb' },
    },
    preview: extra.preview ?? '',
    lastActiveAt: at,
    state: {
      needsYou: extra.needsYou ?? 0,
      unread: extra.unread ?? 0,
      running: extra.running ?? 0,
    },
  };
}

test('机器人按最近活动排序，同一时刻保持原顺序', () => {
  const older = bot('older', '2026-09-27T01:00:00.000Z');
  const newer = bot('newer', '2026-09-27T03:00:00.000Z', { needsYou: 4 });
  const tiedA = bot('tied-a', '2026-09-27T02:00:00.000Z');
  const tiedB = bot('tied-b', '2026-09-27T02:00:00.000Z');
  const visible = visibleBotList([older, tiedB, newer, tiedA]);
  assert.deepEqual(visible.map((item) => item.workspaceId), ['newer', 'tied-b', 'tied-a', 'older']);
});

test('需要你筛选只留有待处理的行，不按角标重排', () => {
  const quiet = bot('quiet', '2026-09-27T04:00:00.000Z');
  const later = bot('later', '2026-09-27T03:00:00.000Z', { needsYou: 1 });
  const sooner = bot('sooner', '2026-09-27T02:00:00.000Z', { needsYou: 9 });
  const visible = visibleBotList([quiet, sooner, later], { needsYouOnly: true });
  assert.deepEqual(visible.map((item) => item.workspaceId), ['later', 'sooner']);
  assert.equal(sumNeedsYou([quiet, sooner, later]), 10);
});

test('搜索合并保留本地角标，并收下只靠任务标题命中的机器人', () => {
  const local = bot('notes', '2026-09-27T03:00:00.000Z', { name: '笔记', preview: '发布说明草稿', needsYou: 2, unread: 1 });
  const staleHit = bot('notes', '2026-09-27T01:00:00.000Z', { name: '笔记', preview: '发布说明草稿', needsYou: 0 });
  const titleOnly = bot('release', '2026-09-27T02:00:00.000Z', { name: '发布', preview: '没有这段字' });
  const merged = mergeBotSearch([local, bot('other', '2026-09-27T04:00:00.000Z')], [titleOnly, staleHit]);
  assert.deepEqual(merged.map((item) => item.workspaceId), ['notes', 'release']);
  assert.equal(merged[0]?.state.needsYou, 2);
  assert.equal(merged[0]?.state.unread, 1);
  assert.equal(visibleBotList(merged, { needsYouOnly: true }).map((item) => item.workspaceId).join(','), 'notes');
});

test('局部刷新替换单行并在归档后从列表拿掉，选中还在全量里就保持', () => {
  const notes = bot('notes', '2026-09-27T01:00:00.000Z', { needsYou: 1 });
  const peer = bot('peer', '2026-09-27T02:00:00.000Z');
  const refreshed = applyBotRefresh([notes, peer], [{
    workspaceId: 'notes',
    item: bot('notes', '2026-09-27T05:00:00.000Z', { needsYou: 3, preview: '新预览' }),
  }]);
  assert.deepEqual(refreshed.map((item) => item.workspaceId), ['notes', 'peer']);
  assert.equal(refreshed[0]?.preview, '新预览');
  assert.equal(retainSelectedId('peer', refreshed), 'peer');
  const archived = applyBotRefresh(refreshed, [{ workspaceId: 'notes', item: null }]);
  assert.deepEqual(archived.map((item) => item.workspaceId), ['peer']);
  assert.equal(retainSelectedId('notes', archived), null);
  assert.equal(retainSelectedId('peer', archived), 'peer');
  assert.equal(visibleBotList(archived, { needsYouOnly: true }).length, 0);
});

test('筛选把当前行藏起来时选中仍留在全量列表', () => {
  const quiet = bot('quiet', '2026-09-27T04:00:00.000Z');
  const loud = bot('loud', '2026-09-27T01:00:00.000Z', { needsYou: 1 });
  const catalog = [quiet, loud];
  const visible = visibleBotList(catalog, { needsYouOnly: true });
  assert.equal(visible.some((item) => item.workspaceId === 'quiet'), false);
  assert.equal(retainSelectedId('quiet', catalog), 'quiet');
  assert.equal(enterBotSelection(visible, 'quiet'), 'loud');
});

test('上下选择在可见行里移动，到头停住', () => {
  const visible = [
    bot('a', '2026-09-27T03:00:00.000Z'),
    bot('b', '2026-09-27T02:00:00.000Z'),
    bot('c', '2026-09-27T01:00:00.000Z'),
  ];
  assert.equal(moveBotSelection(visible, 'b', 1), 'c');
  assert.equal(moveBotSelection(visible, 'b', -1), 'a');
  assert.equal(moveBotSelection(visible, 'a', -1), 'a');
  assert.equal(moveBotSelection(visible, 'c', 1), 'c');
  assert.equal(moveBotSelection(visible, 'missing', 1), 'a');
  assert.equal(moveBotSelection(visible, 'missing', -1), 'c');
  assert.equal(enterBotSelection(visible, 'b'), 'b');
  assert.equal(moveBotSelection([], 'a', 1), 'a');
});

test('空白机器人名字与 main 的清洗和保留名一致', () => {
  assert.deepEqual(validateManagedBotName('  笔记. '), { ok: true, name: '笔记' });
  assert.deepEqual(validateManagedBotName('a/b'), { ok: true, name: 'ab' });
  assert.deepEqual(validateManagedBotName('笔记/../笔记'), { ok: true, name: '笔记..笔记' });
  assert.deepEqual(validateManagedBotName(`\u0001${'甲'.repeat(41)}`), { ok: true, name: '甲'.repeat(40) });
  assert.deepEqual(validateManagedBotName('con'), { ok: false, code: 'INVALID_NAME' });
  assert.deepEqual(validateManagedBotName('COM1'), { ok: false, code: 'INVALID_NAME' });
  assert.deepEqual(validateManagedBotName('lpt9'), { ok: false, code: 'INVALID_NAME' });
  assert.deepEqual(validateManagedBotName(''), { ok: false, code: 'INVALID_NAME' });
  assert.deepEqual(validateManagedBotName('..'), { ok: false, code: 'INVALID_NAME' });
  assert.deepEqual(validateManagedBotName(' \u200b. '), { ok: false, code: 'INVALID_NAME' });
});

test('列表宽度夹在 240 到 360，缺省 292', () => {
  assert.equal(clampBotListWidth(292), 292);
  assert.equal(clampBotListWidth(100), 240);
  assert.equal(clampBotListWidth(900), 360);
  assert.equal(clampBotListWidth(Number.NaN), 292);
  assert.equal(readBotListWidth(null), 292);
  assert.equal(readBotListWidth('300.4'), 300);
});

test('同一天显示时分，更早的日期显示月日', () => {
  const now = new Date(2026, 8, 27, 15, 0, 0).getTime();
  const morning = new Date(2026, 8, 27, 9, 5, 0);
  const yesterday = new Date(2026, 8, 26, 9, 5, 0);
  assert.equal(formatBotListTime(morning.toISOString(), now), '09:05');
  assert.equal(formatBotListTime(yesterday.toISOString(), now), '9/26');
  assert.equal(formatBotListTime('not-a-time', now), '');
});
