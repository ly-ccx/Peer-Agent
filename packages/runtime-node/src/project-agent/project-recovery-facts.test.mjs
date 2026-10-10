import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopProjectFacts } from './project-facts.mjs';

function world() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-recovery-facts-'));
  const messages = [{ id: 'failed', kind: 'agent_turn', meta: { workId: 'work' } },
    { id: 'failed-card', card: 'agent_unavailable', turnId: 'failed', content: '代理暂时不可用：timeout',
      recovery: { reservationId: 'stale', retryAt: '2030-01-01T00:00:00Z' } }];
  const work = { workId: 'work', state: 'retry_wait', waitFor: [{ kind: 'retry_timer', id: 'current' }],
    recovery: { failureKind: 'network', retryable: true, autoAttempts: 0, failedTurnId: 'failed',
      reservationId: 'current', retryAt: '2026-10-10T06:00:02Z', deadlineAt: '2026-10-10T06:05:00Z' } };
  const facts = createDesktopProjectFacts({ runtimeRoot: root,
    supervisor: { sessionsForProject: () => [] }, approvalStore: { list: () => [] }, profileStore: { read: () => ({ agentConversationId: 'c' }) },
    conversationStore: { getPersistedConversationHistory: () => ({ messages }) }, readCoordination: () => ({ works: { work } }),
    now: () => '2026-10-10T06:00:00Z' });
  return { work, messages, card: () => facts.cards('w').find(card => card.kind === 'agent_unavailable'), close: () => rmSync(root, { recursive: true, force: true }) };
}

test('failure card uses the latest local recovery reservation and removes consumed or expired ones', () => {
  const env = world();
  try {
    assert.equal(env.card().recovery.reservationId, 'current');
    env.work.state = 'runnable'; env.work.waitFor = [];
    assert.equal(env.card().recovery.reservationId, undefined);
    assert.equal(env.card().recoveryWorkState, 'runnable');
    env.work.state = 'retry_wait'; env.work.waitFor = [{ kind: 'retry_timer', id: 'current' }];
    env.work.recovery.deadlineAt = '2026-10-10T05:59:00Z';
    assert.equal(env.card().recovery.reservationId, undefined);
  } finally { env.close(); }
});

test('same-work success or pause resolves its old interruption while unrelated replies do not', () => {
  const env = world();
  try {
    env.messages.push({ id: 'unrelated', kind: 'agent_turn', role: 'assistant', meta: { workId: 'other' } });
    assert.equal(env.card().resolvedState, 'open');
    for (const state of ['delivered', 'paused', 'cancelled']) {
      env.work.state = state;
      assert.equal(env.card().resolvedState, 'resolved'); assert.equal(env.card().recovery, undefined);
    }
  } finally { env.close(); }
});
