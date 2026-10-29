import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFailureStatus } from './reply-failure-facts.mjs';

test('only a delivered canonical reply for the same work proves recovery', () => {
  const turn = { id: 't1', kind: 'agent_turn', turnKind: 'wake', meta: { workId: 'w' } };
  const error = { turnId: 't1' };
  const messages = [turn, error];
  const work = { workId: 'w', sessionIds: ['s'], state: 'blocked_system' };
  const sessions = [{ sessionId: 's', status: 'running' }, { sessionId: 'unrelated', status: 'running' }];
  const deliveries = {};
  const status = () => replyFailureStatus(error, messages, [work], deliveries, sessions);
  assert.deepEqual(status(), { phase: 'current', turnKind: 'wake', workId: 'w', activeSessionIds: ['s'] });
  messages.push({ id: 't2', kind: 'agent_turn', meta: { workId: 'w', silentWait: { source: 'host', sessionIds: ['s'] } } });
  work.state = 'waiting_children'; assert.equal(status().phase, 'superseded');
  messages.push({ id: 'r', kind: 'agent_reply', turnId: 't2', meta: { workId: 'other' } });
  deliveries.r = { state: 'delivered' }; assert.equal(status().phase, 'superseded');
  messages.at(-1).meta.workId = 'w';
  for (const state of ['prepared', 'invalidated']) { deliveries.r.state = state; assert.equal(status().phase, 'superseded'); }
  deliveries.r.state = 'delivered'; assert.equal(status().phase, 'recovered'); assert.equal(status().recoveredByReplyId, 'r');
  work.state = 'cancelled'; assert.equal(status().phase, 'cancelled');
  work.state = 'paused'; assert.equal(status().phase, 'paused');
});

test('a later failure does not resolve the current error or unrelated legacy errors', () => {
  const a = { turnId: 'a', meta: { workId: 'w' } }, b = { turnId: 'b', meta: { workId: 'w' } };
  const messages = [{ id: 'a', kind: 'agent_turn', meta: { workId: 'w' } }, a,
    { id: 'b', kind: 'agent_turn', meta: { workId: 'w' } }, b];
  const works = [{ workId: 'w', state: 'blocked_system' }];
  assert.equal(replyFailureStatus(a, messages, works, {}, []).phase, 'superseded');
  assert.equal(replyFailureStatus(b, messages, works, {}, []).phase, 'current');
  works[0].state = 'runnable'; assert.equal(replyFailureStatus(b, messages, works, {}, []).phase, 'retrying');
  assert.equal(replyFailureStatus({ turnId: 'legacy' }, messages, works, {}, []).phase, 'current');
});

test('a consumed or expired retry reservation cannot promise another automatic reply', () => {
  const message = { turnId: 't', meta: { workId: 'w' } };
  const work = { workId: 'w', state: 'retry_wait', recovery: { reservationId: 'r', deadlineAt: '2026-10-18T00:05:00Z' },
    waitFor: [{ kind: 'retry_timer', id: 'r' }] };
  const status = now => replyFailureStatus(message, [message], [work], {}, [], now);
  assert.equal(status('2026-10-18T00:01:00Z').phase, 'retrying');
  assert.equal(status('2026-10-18T00:06:00Z').phase, 'current');
  work.waitFor = [];
  assert.equal(status('2026-10-18T00:01:00Z').phase, 'current');
});
