import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundWork, indexBotWork, replyWork, workProgress } from './botWorkState.ts';
import { createI18n } from '@peer-agent/i18n';
import type { BotChatMessage } from './botConversationState';
import type { DrawerSession } from './drawerState';

function session(id: string, status = 'running', anchorMessageId = ''): DrawerSession {
  return { sessionId: id, status, anchorMessageId, title: '核查历史记录', statusLabel: '', spawnedAt: '', conversationId: '', modelLabel: '', summary: '', evidenceRefs: [], progress: '' };
}
const reply: Pick<BotChatMessage, 'sources' | 'marks' | 'meta' | 'replyTo'> = {
  sources: ['work-1'], marks: [], meta: { sessionStates: [{ sessionId: 'work-1', status: 'running' }] }, replyTo: ['input-1'],
};
test('latest host status overrides a reply snapshot, including terminal and waiting states', () => {
  for (const status of ['waiting_user', 'accepted', 'cancelled']) {
    assert.equal(replyWork(reply, indexBotWork([session('work-1', status)], true))[0].status, status);
  }
});
test('an active verifier cannot present a worker report or stale label as completed', () => {
  const current = { ...session('work-1', 'verifying'), summary: '已完成', statusLabel: '已完成' };
  const row = replyWork(reply, indexBotWork([current], true))[0];
  assert.equal(workProgress(row, createI18n('zh-CN')), '正在核对执行结果，结束后会在对话中告诉你。');
  assert.match(workProgress(row, createI18n('en-US')), /^Checking the execution result/);
  assert.equal(workProgress({ ...row, status: null }, createI18n('zh-CN')), '暂时无法获取最新任务状态，请打开任务查看。');
  const running = { ...session('work-1'), summary: '逐条核对历史记录' };
  assert.equal(workProgress(replyWork(reply, indexBotWork([running], true))[0], createI18n('zh-CN')), running.summary);
});
test('missing, failed or unrecognized host facts never replay a historical running claim', () => {
  for (const index of [indexBotWork([], true), indexBotWork([session('work-1')], false), indexBotWork([session('work-1', 'unknown')], true)]) {
    assert.equal(replyWork(reply, index)[0].status, null);
  }
});
test('structured source, mark, state and exact input anchor deduplicate; unrelated anchors are excluded', () => {
  const index = indexBotWork([session('work-1', 'running', 'input-1'), session('work-2', 'queued', 'input-1'), session('work-3', 'running', 'other-input')], true);
  assert.deepEqual(replyWork({ ...reply, marks: [{ sessionId: 'work-2', outcome: 'passed' }] }, index).map(row => row.id), ['work-1', 'work-2']);
  assert.deepEqual(replyWork({ sources: [], marks: [], meta: {}, replyTo: [] }, index), []);
});
test('a compact reply retains at most 100 structured associations', () => {
  assert.equal(replyWork({ ...reply, sources: Array.from({ length: 1000 }, (_, i) => `s-${i}`) }, indexBotWork([], true)).length, 100);
});
test('background summary prioritizes attention, bounds rendered rows and counts all active work', () => {
  const work = backgroundWork(indexBotWork([...Array.from({ length: 1000 }, (_, i) => session(`q-${i}`, 'queued')), session('waiting', 'waiting_user'), session('done', 'accepted')], true));
  assert.equal(work.count, 1001); assert.equal(work.rows.length, 100); assert.equal(work.rows[0].id, 'waiting');
  assert.deepEqual(backgroundWork(indexBotWork([session('old')], false)), { count: 0, rows: [] });
});
