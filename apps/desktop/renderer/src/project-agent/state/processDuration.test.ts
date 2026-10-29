import assert from 'node:assert/strict';
import test from 'node:test';
import { processSeconds, processDuration } from './processDuration.ts';
import { normalizeBotMessage } from './botConversationState.ts';
import { agentProcessEntries } from '../drawer/agentProcess.ts';
import type { I18nRuntime } from '@peer-agent/i18n';

const i18n = { t: (key: string, params?: unknown) => `${key}:${JSON.stringify(params)}` } as I18nRuntime;
test('subsecond timing is explicit; absent or invalid historical timing stays unknown', () => {
  assert.equal(processSeconds(undefined, undefined, 0), null);
  assert.equal(processSeconds('2026-10-06T00:00:00Z', undefined, 2000, true), null);
  assert.equal(processSeconds('2026-10-06T00:00:00Z', '2026-10-05T00:00:00Z', 0), null);
  assert.equal(processSeconds('2026-10-06T00:00:00Z', '2026-10-06T00:00:00.250Z', 0, true), .25);
  assert.match(processDuration(.25, i18n), /lessThanSecond/);
  assert.match(processDuration(0, i18n), /lessThanSecond/);
  assert.match(processDuration(65.9, i18n), /minutes.*"seconds":5,"minutes":1/);
});
test('reload keeps saved tool timings and old records have no invented elapsed time', () => {
  const message = normalizeBotMessage({ id: 'timed', kind: 'agent_turn', rounds: [{ toolCalls: [
    { name: 'read_file', result: { ok: true }, startedAtMs: 1000, endedAtMs: 3250 },
    { name: 'list_sessions', result: { ok: true } },
  ] }] })!;
  const steps = agentProcessEntries(message.rounds);
  assert.equal(processSeconds(steps[0].startedAt, steps[0].finishedAt, 0, true), 2.25);
  assert.equal(processSeconds(steps[1].startedAt, steps[1].finishedAt, 10000, true), null);
});
