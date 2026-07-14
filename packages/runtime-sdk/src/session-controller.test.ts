import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeSessionController } from './session-controller.ts';

function createController() {
  let clock = 0;
  const changes: string[] = [];
  const controller = createRuntimeSessionController({
    createTurnId: (sessionId, turnIndex) => `${sessionId}:turn:${turnIndex}`,
    now: () => `2026-07-13T00:00:0${clock++}.000Z`,
    onChange: (snapshot) => {
      const turn = snapshot.activeTurn ?? snapshot.lastTurn;
      changes.push(`${snapshot.status}:${turn?.turnIndex ?? '-'}:${turn?.status ?? '-'}`);
    },
  });
  return { controller, changes };
}

test('starts a session and completes its first turn', () => {
  const { controller, changes } = createController();
  const turn = controller.start({
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    streamId: 'stream-1',
  });

  assert.equal(turn.turnId, 'session-1:turn:0');
  assert.equal(turn.turnIndex, 0);
  assert.equal(turn.signal.aborted, false);
  assert.deepEqual(turn.snapshot(), {
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    status: 'running',
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z',
    nextTurnIndex: 1,
    activeTurn: {
      turnId: 'session-1:turn:0',
      turnIndex: 0,
      streamId: 'stream-1',
      status: 'running',
      startedAt: '2026-07-13T00:00:00.000Z',
    },
  });

  const completed = turn.complete();
  assert.equal(completed.status, 'idle');
  assert.equal(completed.activeTurn, undefined);
  assert.equal(completed.lastTurn?.status, 'completed');
  assert.equal(completed.lastTurn?.completedAt, '2026-07-13T00:00:01.000Z');
  assert.deepEqual(changes, ['running:0:running', 'idle:0:completed']);
});

test('resumes an idle session with monotonic turn indexes and stable session identity', () => {
  const { controller } = createController();
  controller.start({
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    streamId: 'stream-1',
  }).complete();

  const resumed = controller.resume({
    sessionId: 'session-1',
    streamId: 'stream-2',
  });

  assert.equal(resumed.sessionId, 'session-1');
  assert.equal(resumed.conversationId, 'conversation-1');
  assert.equal(resumed.turnId, 'session-1:turn:1');
  assert.equal(resumed.turnIndex, 1);
  assert.equal(resumed.snapshot().nextTurnIndex, 2);
  assert.equal(resumed.snapshot().activeTurn?.streamId, 'stream-2');
});

test('cancels the active turn and aborts its signal exactly once', () => {
  const { controller } = createController();
  const turn = controller.start({ sessionId: 'session-1' });
  let aborts = 0;
  turn.signal.addEventListener('abort', () => { aborts += 1; });

  const cancelled = controller.cancel('session-1', 'user_aborted');
  assert.equal(turn.signal.aborted, true);
  assert.equal(aborts, 1);
  assert.equal(cancelled?.status, 'idle');
  assert.equal(cancelled?.lastTurn?.status, 'cancelled');
  assert.equal(cancelled?.lastTurn?.reason, 'user_aborted');

  const repeated = controller.cancel('session-1', 'again');
  assert.equal(repeated?.lastTurn?.reason, 'user_aborted');
  assert.equal(aborts, 1);
});

test('merges an external AbortSignal into the owned turn signal', () => {
  const { controller } = createController();
  const external = new AbortController();
  const turn = controller.start({ sessionId: 'session-1', signal: external.signal });

  external.abort('host_aborted');

  assert.equal(turn.signal.aborted, true);
  assert.equal(controller.get('session-1')?.lastTurn?.status, 'cancelled');
  assert.equal(controller.get('session-1')?.lastTurn?.reason, 'host_aborted');
});

test('fails the active turn while aborting remaining host work', () => {
  const { controller } = createController();
  const turn = controller.start({ sessionId: 'session-1' });

  const failed = turn.fail('repetition_detected');

  assert.equal(turn.signal.aborted, true);
  assert.equal(failed.status, 'idle');
  assert.equal(failed.lastTurn?.status, 'failed');
  assert.equal(failed.lastTurn?.reason, 'repetition_detected');
});

test('rejects duplicate starts, overlapping turns, and unknown resumes', () => {
  const { controller } = createController();
  controller.start({ sessionId: 'session-1' });

  assert.throws(
    () => controller.start({ sessionId: 'session-1' }),
    /already exists/,
  );
  assert.throws(
    () => controller.resume({ sessionId: 'session-1' }),
    /active turn/,
  );
  assert.throws(
    () => controller.resume({ sessionId: 'missing' }),
    /does not exist/,
  );
});

test('ignores stale terminal calls after a turn has already been cancelled', () => {
  const { controller } = createController();
  const turn = controller.start({ sessionId: 'session-1' });
  controller.cancel('session-1', 'user_aborted');

  const snapshot = turn.complete();
  assert.equal(snapshot.lastTurn?.status, 'cancelled');
  assert.equal(snapshot.lastTurn?.reason, 'user_aborted');
});
