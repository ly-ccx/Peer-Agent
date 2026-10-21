import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBotMessage, visibleBotMessages } from './botConversationState.ts';
import { agentIdentity } from './agentActivityState.ts';

const activity = (id: string, sessionId = 'child', at = '2026-10-21T00:00:00Z', state = 'reported') =>
  normalizeBotMessage({ id, kind: 'agent_activity', createdAt: at,
    agentActivity: { eventId: id, sessionId, name: '实现检查', state } })!;

test('legacy same-time returned-result rows coalesce without changing history or hiding different agents or later reports', () => {
  const source = [activity('report'), activity('result-ready'), activity('other', 'other'),
    activity('later', 'child', '2026-10-21T00:01:00Z'), activity('ended', 'child', '2026-10-21T00:01:00Z', 'ended')];
  assert.deepEqual(visibleBotMessages(source).map(row => row.id), ['report', 'other', 'later', 'ended']);
  assert.equal(source.length, 5);
  const reply = normalizeBotMessage({ id: 'reply', kind: 'agent_reply', content: '进展' })!;
  assert.equal(visibleBotMessages([activity('a'), reply, activity('b')]).length, 3);
  assert.equal(visibleBotMessages([activity('a', 'child', ''), activity('b', 'child', '')]).length, 2);
  assert.equal(visibleBotMessages([activity('a', 'child', undefined, 'question'), activity('b', 'child', undefined, 'question')]).length, 2);
});

test('agent identity is stable and varies both SVG shape and tone across independent sessions', () => {
  const first = agentIdentity('rc-work-1'), second = agentIdentity('rc-work-2');
  assert.deepEqual(agentIdentity('rc-work-1'), first);
  assert.notEqual(first.icon, second.icon);
  const identities = Array.from({ length: 64 }, (_, i) => agentIdentity(`agent-${i}`));
  assert.ok(new Set(identities.map(row => row.icon)).size >= 6);
  assert.equal(new Set(identities.map(row => row.tone)).size, 4);
});

test('verification activity keeps validated factual progress and coalesces consecutive updates', () => {
  const verificationProgress = { continuationId: 'review', startedAt: '2026-10-21T00:00:00Z',
    lastProgressAt: '2026-10-21T00:01:00Z', observationCount: 7, phase: 'ready' };
  const row = (id: string, count: number) => normalizeBotMessage({ id, kind: 'agent_activity',
    agentActivity: { eventId: id, sessionId: 'child', name: '独立核验', state: 'verifying',
      verificationProgress: { ...verificationProgress, observationCount: count } } })!;
  assert.deepEqual(visibleBotMessages([row('first', 0), row('next', 7)]).map(row => row.id), ['next']);
  assert.equal(row('next', 7).agentActivity?.verificationProgress?.observationCount, 7);
  assert.equal(row('bad', -1).agentActivity?.verificationProgress, undefined);
  assert.equal(visibleBotMessages([row('next', 7), activity('failed', 'child', undefined, 'blocked')]).length, 2);
});
