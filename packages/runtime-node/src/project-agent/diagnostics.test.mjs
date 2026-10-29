import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createProjectDiagnostics } from './diagnostics.mjs';

const secret = '/Users/private/project sk-ABCDEF123456 message body';
const at = '2026-10-02T00:00:00.000Z';
function fixture(overrides = {}) {
  const calls = [];
  const read = (name, value) => (...args) => { calls.push([name, ...args]); return value; };
  const ports = {
    readProjects: read('projects', [{ workspaceId: secret, path: '/Users/private/project', name: secret }]),
    readLease: read('lease', { hostId: secret, surface: 'desktop', pid: 123, acquiredAt: at, heartbeatAt: at, appVersion: secret }),
    readInput: read('input', { depth: 2, executionDepth: 1, cursor: secret, executedCursor: secret }),
    readInbox: read('inbox', { cursor: 201, events: Array.from({ length: 205 }, (_, i) => ({ seq: i + 1, eventId: secret + i, at, kind: 'progress', payload: secret })) }),
    readApprovals: read('approvals', [{ approvalId: secret, state: 'open', capabilityId: secret, summary: secret, argsDigest: secret }]),
    readObjectives: read('objectives', [{ objectiveId: 'objective', title: secret, status: 'active', autonomy: 'report_only', watches: [{ watchId: 'watch', kind: 'event', source: { type: 'files', paths: ['safe.md', '../secret', secret] } }] }]),
    readWatch: read('watch', { lastObservationAt: at, nextRunAt: secret, unavailableReason: secret, pendingExecutionKey: secret }),
    readTurns: read('turns', Array.from({ length: 25 }, (_, i) => ({ id: secret + i, kind: 'agent_turn', content: secret, rounds: [{ output: secret }], ...(i % 2 ? { meta: { diagnosticTiming: { startedAt: at, finishedAt: at, durationMs: i, outcome: 'done' } } } : {}) }))),
    readScheduler: read('scheduler', { stats: { active: 1, waiting: 2, limit: 4 }, queue: [{ workspaceId: secret, planId: secret, priority: 'high', at: 0 }] }),
    ...overrides,
  };
  return { reader: createProjectDiagnostics({ ...ports, now: () => at }), calls };
}

test('diagnostics allowlist removes paths, credentials, prose and IDs; bounded events/turns retain factual states', () => {
  const { reader, calls } = fixture();
  const result = reader.read(), text = JSON.stringify(result);
  assert.equal(result.schemaVersion, 1); assert.equal(result.generatedAt, at);
  assert.equal(text.includes(secret), false); assert.equal(text.includes('/Users/'), false); assert.equal(text.includes('sk-'), false);
  assert.equal(text.includes('message body'), false); assert.equal(text.includes('../secret'), false);
  const bot = result.bots[0];
  assert.deepEqual(bot.identity, { length: secret.length, sha256: createHash('sha256').update(secret).digest('hex') });
  assert.equal(bot.workspace, '.'); assert.equal(bot.lease.surface, 'desktop'); assert.equal(bot.input.depth, 2);
  assert.equal(bot.inbox.events.length, 200); assert.equal(bot.inbox.events[0].seq, 6);
  assert.equal(bot.turns.length, 20); assert.equal(bot.turns[0].durationMs, 5);
  assert.equal(bot.turns[1].outcome, 'unknown'); assert.equal(bot.turns[1].durationMs, null);
  assert.deepEqual(bot.objectives[0].watches[0].paths, ['safe.md']);
  assert.equal(bot.objectives[0].watches[0].nextRunAt, null);
  assert.equal(bot.approvals[0].state, 'open'); assert.equal(result.scheduler.stats.active, 1);
  assert.equal(calls.filter(([name]) => name === 'projects').length, 1);
});

test('corrupt sources yield fixed codes, invalid enum/timing stays unknown, and reading invokes no mutations', () => {
  const { reader, calls } = fixture({
    readLease() { throw Error(secret); }, readInput() { throw Error(secret); },
    readTurns: () => [{ kind: 'agent_turn', id: secret, meta: { diagnosticTiming: { startedAt: at, finishedAt: secret, durationMs: -1, outcome: secret } } }],
  });
  const bot = reader.read().bots[0];
  assert.deepEqual(bot.errors, ['LEASE_UNAVAILABLE', 'INPUT_UNAVAILABLE']);
  assert.equal(bot.lease, null); assert.equal(bot.input, null); assert.equal(bot.turns[0].outcome, 'unknown');
  assert.equal(bot.turns[0].durationMs, null);
  assert.ok(calls.every(([name]) => ['projects','inbox','approvals','objectives','watch','scheduler'].includes(name)));
});
