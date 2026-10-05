import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundWork, indexBotWork, replyWork } from './botWorkState.ts';
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
