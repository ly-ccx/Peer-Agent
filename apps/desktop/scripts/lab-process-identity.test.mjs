import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  STOP_ALREADY_EXITED,
  STOP_CANCELLED,
  STOP_OWNED,
  STOP_REFUSED_FUZZY_SEARCH,
  STOP_REFUSED_PARENT_PID_INFERENCE,
  STOP_REFUSED_UNKNOWN_IDENTITY,
  STOP_TIMEOUT,
  createOwnedProcessRegistry,
  inspectStopRequest,
} from './lab-process-identity.mjs';

class FakeProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', null, signal);
    return true;
  }
}

test('unknown handle is refused and never signaled', async () => {
  const registry = createOwnedProcessRegistry();
  const result = await registry.stop({ handleId: 'not-mine', pid: 1887 });
  assert.equal(result.ok, false);
  assert.equal(result.code, STOP_REFUSED_UNKNOWN_IDENTITY);
  assert.equal(result.signaled, false);
});

test('missing handle is refused as unknown identity', () => {
  const decision = inspectStopRequest({ pid: 1887 }, []);
  assert.equal(decision.code, STOP_REFUSED_UNKNOWN_IDENTITY);
  assert.equal(decision.signaled, false);
});

test('parent pid inference is refused', async () => {
  const registry = createOwnedProcessRegistry();
  const owned = new FakeProcess(9001);
  registry.register({ process: owned });
  const result = await registry.stop({ parentPid: 1887, pid: 75560 });
  assert.equal(result.code, STOP_REFUSED_PARENT_PID_INFERENCE);
  assert.equal(result.signaled, false);
  assert.equal(owned.killed, false);
});

test('pgrep fuzzy hits are refused', async () => {
  const registry = createOwnedProcessRegistry();
  const owned = new FakeProcess(9002);
  const handleId = registry.register({ process: owned });
  const result = await registry.stop({
    via: 'pgrep',
    pgrepHits: ['1887 node apps/desktop/scripts/lab-experiment.mjs'],
    handleId,
  });
  assert.equal(result.code, STOP_REFUSED_FUZZY_SEARCH);
  assert.equal(result.signaled, false);
  assert.equal(owned.killed, false);
});

test('stop waits for a real exit and does not treat killed as already gone', async () => {
  const registry = createOwnedProcessRegistry();
  const owned = new FakeProcess(9099);
  owned.kill = function killWithoutExit() {
    this.killed = true;
    return true;
  };
  const handleId = registry.register({
    process: owned,
    async close() {
      owned.kill();
    },
  });
  const pending = registry.stop({ handleId, waitMs: 40 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const snapshot = registry.snapshot().find((entry) => entry.id === handleId);
  assert.equal(snapshot.exited, false, '发过 close/kill 但还没 exit 时不得标 exited');
  const result = await pending;
  assert.equal(result.signaled, true);
  assert.equal(result.exited, false, '等待超时后仍未退出，exited 必须是 false');
  assert.equal(owned.killed, true);
  assert.equal(owned.signalCode, null);
});

test('owned handle can be stopped through the registered close path', async () => {
  const registry = createOwnedProcessRegistry();
  const owned = new FakeProcess(9100);
  let closed = 0;
  const handleId = registry.register({
    process: owned,
    async close() {
      closed += 1;
      owned.kill('SIGTERM');
    },
  });
  const result = await registry.stop({ handleId });
  assert.equal(result.ok, true);
  assert.equal(result.code, STOP_OWNED);
  assert.equal(result.signaled, true);
  assert.equal(closed, 1);
  assert.equal(owned.killed, true);
});

test('already exited owned process is a no-op, not a signal', async () => {
  const registry = createOwnedProcessRegistry();
  const owned = new FakeProcess(9101);
  let closed = 0;
  const handleId = registry.register({
    process: owned,
    async close() {
      closed += 1;
      owned.kill('SIGTERM');
    },
  });
  owned.kill('SIGTERM');
  const result = await registry.stop({ handleId, reason: 'cancel' });
  assert.equal(result.code, STOP_ALREADY_EXITED);
  assert.equal(result.signaled, false);
  assert.equal(closed, 0);
});

test('cancel cleanup uses the owned handle', async () => {
  const registry = createOwnedProcessRegistry();
  const owned = new FakeProcess(9102);
  const handleId = registry.register({
    process: owned,
    async close() {
      owned.kill('SIGTERM');
    },
  });
  const result = await registry.cancel(handleId);
  assert.equal(result.code, STOP_CANCELLED);
  assert.equal(result.signaled, true);
  assert.equal(owned.killed, true);
});

test('timeout cleanup uses the owned handle', async () => {
  const registry = createOwnedProcessRegistry();
  const owned = new FakeProcess(9103);
  const handleId = registry.register({
    process: owned,
    async close() {
      owned.kill('SIGTERM');
    },
  });
  const result = await registry.timeout(handleId);
  assert.equal(result.code, STOP_TIMEOUT);
  assert.equal(result.signaled, true);
  assert.equal(owned.killed, true);
});

test('pid mismatch against an owned handle is refused', async () => {
  const registry = createOwnedProcessRegistry();
  const owned = new FakeProcess(9104);
  const handleId = registry.register({ process: owned });
  const result = await registry.stop({ handleId, pid: 1887 });
  assert.equal(result.code, STOP_REFUSED_UNKNOWN_IDENTITY);
  assert.equal(result.signaled, false);
  assert.equal(owned.killed, false);
});
