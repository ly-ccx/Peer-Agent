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
