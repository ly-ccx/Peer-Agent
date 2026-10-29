import assert from 'node:assert/strict';
import test from 'node:test';
import { groupDrawerSessions, taskGroup } from './drawerState.ts';
import type { DrawerSession } from './drawerState.ts';
import type { FollowUpProjection } from '@peer-agent/protocol';

function session(sessionId: string, status: string, followUp?: FollowUpProjection): DrawerSession {
  return { sessionId, status, followUp } as unknown as DrawerSession;
}

test('分组只按宿主跟进责任：技术验收不再进“需要你”', () => {
  assert.equal(taskGroup('result_ready', {
    owner: 'bot', inCurrentList: true, reason: 'awaiting_acceptance_technical',
  }), 'running');
  assert.equal(taskGroup('result_ready', {
    owner: 'user', inCurrentList: true, reason: 'awaiting_human_gate',
  }), 'needsYou');
  assert.equal(taskGroup('verifying', {
    owner: 'bot', inCurrentList: true, reason: 'live_execution',
  }), 'running');
});

test('已签收/已确认停止进“已完成”，被承接/暂停单列', () => {
  assert.equal(taskGroup('accepted', { owner: 'none', inCurrentList: false, reason: 'settled' }), 'done');
  assert.equal(taskGroup('cancelled', { owner: 'none', inCurrentList: false, reason: 'stop_confirmed' }), 'done');
  assert.equal(taskGroup('superseded', { owner: 'none', inCurrentList: false, reason: 'superseded' }), 'paused');
  assert.equal(taskGroup('paused', { owner: 'none', inCurrentList: false, reason: 'paused' }), 'paused');
});

test('停止回执未决仍留在“进行中”，不落完成分组', () => {
  assert.equal(taskGroup('cancelled', { owner: 'bot', inCurrentList: true, reason: 'stop_unconfirmed' }), 'running');
});

test('整组投影：同一批会话按宿主判定分组', () => {
  const groups = groupDrawerSessions([
    session('bot-1', 'result_ready', { owner: 'bot', inCurrentList: true, reason: 'awaiting_acceptance_technical' }),
    session('user-1', 'waiting_user', { owner: 'user', inCurrentList: true, reason: 'human_request' }),
    session('done-1', 'accepted', { owner: 'none', inCurrentList: false, reason: 'settled' }),
  ]);
  assert.deepEqual(groups.running.map(row => row.sessionId), ['bot-1']);
  assert.deepEqual(groups.needsYou.map(row => row.sessionId), ['user-1']);
  assert.deepEqual(groups.done.map(row => row.sessionId), ['done-1']);
});

test('旧记录缺 followUp 时维持既有分组，不新造终态', () => {
  assert.equal(taskGroup('result_ready'), 'needsYou');
  assert.equal(taskGroup('superseded'), 'paused');
  assert.equal(taskGroup('accepted'), 'done');
});
