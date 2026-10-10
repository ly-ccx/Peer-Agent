import assert from 'node:assert/strict';
import test from 'node:test';
import { retryProjectAgentTurn } from './response-retry.mjs';

function fixture(retry) {
  const messages = [
    { id: 'old', kind: 'agent_turn', turnKind: 'wake', userInputs: [] },
    { id: 'old-card', kind: 'system_card', card: 'agent_unavailable', turnId: 'old' },
  ];
  const resolutions = [];
  let leased = true;
  const runner = { parked: () => true, status: () => 'idle', retry: () => retry({ messages, loseLease: () => { leased = false; } }) };
  const deps = { holdsLease: () => leased, resolveConversationId: () => 'conv',
    conversationStore: { getPersistedConversationHistory: () => ({ messages }) },
    projectFacts: { cards: () => [], resolve: (...args) => resolutions.push(args) },
    host: { runnerFor: () => runner } };
  return { deps, resolutions, messages };
}

test('disposal ending a retry wait does not resolve the failure card', async () => {
  const f = fixture(async () => undefined);
  assert.deepEqual(await retryProjectAgentTurn({ workspaceId: 'ws', turnId: 'old' }, f.deps), { ok: false, code: 'TURN_FAILED' });
  assert.deepEqual(f.resolutions, []);
});

test('retry only resolves after a new canonical successful turn is persisted', async () => {
  const f = fixture(async ({ messages }) => messages.push({ id: 'new', kind: 'agent_turn', meta: { diagnosticTiming: { outcome: 'done' } } }));
  assert.deepEqual(await retryProjectAgentTurn({ workspaceId: 'ws', turnId: 'old' }, f.deps), { ok: true });
  assert.deepEqual(f.resolutions, [['ws', 'card:agent_unavailable:old']]);
});

test('failed and user-stopped attempts never produce a successful retry receipt', async () => {
  for (const outcome of ['error', undefined]) {
    const f = fixture(async ({ messages }) => messages.push({ id: 'new', kind: 'agent_turn', meta: { diagnosticTiming: { outcome } } }));
    assert.equal((await retryProjectAgentTurn({ workspaceId: 'ws', turnId: 'old' }, f.deps)).ok, false);
    assert.deepEqual(f.resolutions, []);
  }
});

test('lease loss prevents a successful retry receipt even after provider completion', async () => {
  const f = fixture(async ({ messages, loseLease }) => {
    messages.push({ id: 'new', kind: 'agent_turn', meta: { diagnosticTiming: { outcome: 'done' } } });
    loseLease();
  });
  assert.deepEqual(await retryProjectAgentTurn({ workspaceId: 'ws', turnId: 'old' }, f.deps), { ok: false, code: 'HOST_OFFLINE' });
  assert.deepEqual(f.resolutions, []);
});

test('unknown outcome and missing checkpoints keep their specific durable recovery rejection', async () => {
  for (const code of ['EXECUTION_OUTCOME_UNKNOWN', 'RECOVERY_CHECKPOINT_UNAVAILABLE', 'STALE_TURN', 'WORK_BUDGET_EXHAUSTED']) {
    const f = fixture(async () => ({ ok: false, code }));
    assert.deepEqual(await retryProjectAgentTurn({ workspaceId: 'ws', turnId: 'old' }, f.deps), { ok: false, code });
    assert.equal(f.resolutions.length, 0);
  }
});

test('another work completing cannot resolve a bound recovery card', async () => {
  const f = fixture(async ({ messages }) => {
    messages.push({ id: 'unrelated', kind: 'agent_turn', meta: { workId: 'other', diagnosticTiming: { outcome: 'done' } } });
    return { ok: true, workId: 'original', turnId: 'recovery' };
  });
  f.messages[0].meta = { workId: 'original' };
  f.messages[1].meta = { workId: 'original' };
  assert.equal((await retryProjectAgentTurn({ workspaceId: 'ws', turnId: 'old' }, f.deps)).ok, false);
  assert.equal(f.resolutions.length, 0);
});
