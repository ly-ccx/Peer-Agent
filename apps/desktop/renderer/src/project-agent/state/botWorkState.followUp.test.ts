import assert from 'node:assert/strict';
import test from 'node:test';
import { backgroundWork, indexBotWork } from './botWorkState.ts';
import type { DrawerSession } from './drawerState.ts';
import type { FollowUpProjection } from '@peer-agent/protocol';

function session(sessionId: string, status: string, followUp?: FollowUpProjection): DrawerSession {
  return { sessionId, status, followUp } as unknown as DrawerSession;
}

test('列表与计数都按宿主 followUp 判定（不按 status 各自过滤）', () => {
  const index = indexBotWork([
    session('bot-1', 'result_ready', { owner: 'bot', inCurrentList: true, reason: 'awaiting_acceptance_technical' }),
    session('settled-1', 'accepted', { owner: 'none', inCurrentList: false, reason: 'settled' }),
    session('user-1', 'result_ready', { owner: 'user', inCurrentList: true, reason: 'awaiting_human_gate' }),
    session('stop-1', 'cancelled', { owner: 'none', inCurrentList: false, reason: 'stop_confirmed' }),
  ], true);
  const work = backgroundWork(index);
  assert.deepEqual(work.rows.map(row => row.id), ['bot-1', 'user-1']);
  assert.equal(work.count, work.rows.length);
  assert.equal(work.count, 2);
});

test('旧记录缺 followUp 时 fail closed：仍留在列表', () => {
  const index = indexBotWork([session('legacy-1', 'result_ready')], true);
  const work = backgroundWork(index);
  assert.deepEqual(work.rows.map(row => row.id), ['legacy-1']);
  assert.equal(work.count, 1);
});

test('活动执行/核验的宿主判定不会被列表误隐藏', () => {
  const index = indexBotWork([
    session('verify-1', 'verifying', { owner: 'bot', inCurrentList: true, reason: 'live_execution' }),
    session('stop-pending-1', 'stopping', { owner: 'bot', inCurrentList: true, reason: 'stop_unconfirmed' }),
  ], true);
  assert.equal(backgroundWork(index).count, 2);
});
