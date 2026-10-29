import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORY_PAGE_SIZE, historyTitle, presentHistory, type HistoryConversation } from './historyPresentation.ts';
const now = new Date(2026, 0, 2, 0, 10).getTime();
const row = (id: string, date: Date, title = id): HistoryConversation => ({ id, title, updatedAt: date.toISOString() });

test('history groups local calendar days across a year boundary and sorts by actual update time', () => {
  const items = [row('old', new Date(2025, 11, 1)), row('yesterday', new Date(2026, 0, 1, 23, 59)),
    row('week', new Date(2025, 11, 31)), row('today', new Date(2026, 0, 2, 0, 1))];
  const copy = [...items];
  assert.deepEqual(presentHistory(items, '', 40, now).groups.map(group => group.key), ['today', 'yesterday', 'week', 'earlier']);
  assert.deepEqual(items, copy);
});
test('history search matches all normalized title terms without searching internal identifiers', () => {
  const items = [row('opaque-needle', new Date(now), 'MiMo 请求修复'), row('other', new Date(now), 'MiMo 模型配置')];
  assert.equal(presentHistory(items, '  ＭＩＭＯ  修复 ', 40, now).count, 1);
  assert.equal(presentHistory(items, 'needle', 40, now).count, 0);
  assert.equal(presentHistory(items, '   ', 40, now).count, 2);
});
test('invalid and future dates never invent a recent day; untitled records never display raw IDs', () => {
  const missing = { id: 'opaque-id', title: '', updatedAt: 'invalid' };
  const future = row('future', new Date(2026, 0, 3));
  const groups = presentHistory([missing, future], '', 40, now).groups;
  assert.deepEqual(groups.map(group => group.key), ['other']);
  assert.deepEqual(groups[0].rows.map(item => item.id), ['future', 'opaque-id']);
  assert.equal(historyTitle(missing, '未命名对话'), '未命名对话');
  assert.equal(historyTitle({ ...missing, title: missing.id }, '未命名对话'), '未命名对话');
});
test('history reveals bounded rows progressively and retains stable ties', () => {
  const items = Array.from({ length: 91 }, (_, index) => row(String(index), new Date(now), '相同时间'));
  const first = presentHistory(items, '', undefined, now);
  assert.equal(first.shown, HISTORY_PAGE_SIZE); assert.equal(first.count, 91); assert.equal(first.hasMore, true);
  assert.deepEqual(first.groups[0].rows.map(item => item.id), items.slice(0, 40).map(item => item.id));
  assert.equal(presentHistory(items, '', 120, now).hasMore, false);
  assert.equal(presentHistory(items, '', 0, now).shown, 0);
});
