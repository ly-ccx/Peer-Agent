import assert from 'node:assert/strict';
import test from 'node:test';

import { STALL_WINDOW_MS } from './watchdog.mjs';
import { createWatchPublisher } from './watch-publisher.mjs';

const COMPLETED_AT = '2026-10-01T00:00:00.000Z';
const session = {
  sessionId: 'session-r', workspaceId: 'ws-1', status: 'result_ready',
  startedAt: COMPLETED_AT, completedAt: COMPLETED_AT,
};

test('结果等待收下的停滞锚点在临近截止时收紧扫描，远离时跟随轮询', () => {
  const nearDeadline = new Date(Date.parse(COMPLETED_AT) + STALL_WINDOW_MS - 10_000).toISOString();
  const near = createWatchPublisher({ now: () => nearDeadline });
  near.publish('ws-1', { sessions: [session] });
  assert.equal(near.nextDelay('ws-1'), 10_000);

  const farFromDeadline = new Date(Date.parse(COMPLETED_AT) + 60_000).toISOString();
  const far = createWatchPublisher({ now: () => farFromDeadline });
  far.publish('ws-1', { sessions: [session] });
  assert.equal(far.nextDelay('ws-1'), 30_000);
});
