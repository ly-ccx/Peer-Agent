import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceSessionExecution } from './session-execution.mjs';

const plan = (phase, status = 'executing') => ({ status, delegationOrigin: { phase } });
const start = '2026-11-26T00:01:00.000Z';
const end = '2026-11-26T00:02:00.000Z';
const later = '2026-11-26T00:03:00.000Z';

test('only the running transition starts the clock; subsequent writes or requeue preserve it', () => {
  const queued = plan('queued', 'paused');
  const running = plan('running');
  assert.equal(advanceSessionExecution(queued, undefined, start), undefined);
  assert.equal(advanceSessionExecution(plan('starting'), queued, start), undefined);
  running.sessionExecution = advanceSessionExecution(running, queued, start);
  assert.deepEqual(running.sessionExecution, { startedAt: start });
  assert.deepEqual(advanceSessionExecution(queued, running, later), { startedAt: start });
  assert.deepEqual(advanceSessionExecution(plan('running'), { ...queued, sessionExecution: running.sessionExecution }, later), { startedAt: start });
});

test('first result, cancellation, or failure freezes the clock; imported snapshots are not backfilled', () => {
  const running = { ...plan('running'), sessionExecution: { startedAt: start } };
  for (const state of [plan('completed', 'completed'), plan('cancelled', 'cancelled'), plan('failed', 'failed'),
    { ...plan('completed', 'completed'), verificationReport: { passed: false } }]) {
    assert.equal(advanceSessionExecution(state, undefined, later), undefined);
    assert.equal(advanceSessionExecution(state, state, later), undefined);
    state.sessionExecution = advanceSessionExecution(state, running, end);
    assert.deepEqual(state.sessionExecution, { startedAt: start, endedAt: end });
    assert.deepEqual(advanceSessionExecution({ ...state, resultAcceptance: { acceptedAt: later } }, state, later), state.sessionExecution);
  }
  assert.equal(advanceSessionExecution(plan('running'), plan('running'), later), undefined);
  assert.deepEqual(advanceSessionExecution(plan('cancelled', 'cancelled'), plan('queued', 'paused'), end), { endedAt: end });
});
