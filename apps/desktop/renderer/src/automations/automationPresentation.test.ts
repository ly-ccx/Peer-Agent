import assert from 'node:assert/strict';
import test from 'node:test';
import type { AutomationSummary } from '@peer-agent/protocol';
import { automationCounts, nextThreePreview, scheduleLabel } from './automationPresentation.ts';

const summary = (status: 'active' | 'paused', needsAttention = false): AutomationSummary => ({
  definition: {
    automationId: `${status}-${needsAttention}`, version: 1, name: 'Check', prompt: 'Check',
    workspacePath: '/repo', schedule: { kind: 'daily', timezone: 'UTC', hour: 9, minute: 0 },
    grant: { preset: 'observe', workspacePath: '/repo', allowedCapabilityIds: [], askCapabilityIds: [], blockedCapabilityIds: [], confirmedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    notifications: { needsAttention: 'system_and_badge', failed: true, succeeded: false },
    budget: { timeoutMs: 60_000 }, missedRunPolicy: 'run_latest', overlapPolicy: 'skip', status,
    consecutiveFailures: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }, needsAttention,
});

test('automation center counts active and attention definitions', () => {
  assert.deepEqual(automationCounts([summary('active'), summary('paused', true)]), { total: 2, active: 1, running: 0, attention: 1 });
});

test('schedule presentation is explicit and previews three occurrences in both locales', () => {
  const schedule = { kind: 'daily' as const, timezone: 'UTC', hour: 9, minute: 5 };
  assert.equal(scheduleLabel(schedule), 'Daily · 09:05');
  assert.equal(scheduleLabel(schedule, 'zh'), '每天 · 09:05');
  assert.equal(nextThreePreview(schedule, new Date('2026-01-01T00:00:00.000Z')).length, 3);
  assert.equal(nextThreePreview(schedule, new Date('2026-01-01T00:00:00.000Z'), 'zh').length, 3);
});
