import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBotMessage, visibleBotMessages, conversationWindowAnchor } from './botConversationState.ts';
import { agentIdentity, agentActivityRunning, readAgentActivity, coalesceAgentActivity, currentAgentActivity, agentActivityPresentationId } from './agentActivityState.ts';
import { conversationRowKey } from './conversationWindow.ts';
import { indexBotWork } from './botWorkState.ts';
import type { DrawerSession } from './drawerState';

const activity = (id: string, sessionId = 'child', at = '2026-10-21T00:00:00Z', state = 'reported') =>
  normalizeBotMessage({ id, kind: 'agent_activity', createdAt: at,
    agentActivity: { eventId: id, sessionId, name: '实现检查', state } })!;

const session = (sessionId: string, status: string): DrawerSession => ({ sessionId, status, title: '实现检查',
  statusLabel: '', spawnedAt: '', conversationId: '', anchorMessageId: '', modelLabel: '', summary: '', evidenceRefs: [], progress: '' });

test('historical start animation follows its own current session and stops without changing history', () => {
  const started = activity('start', 'child', undefined, 'started').agentActivity!;
  const before = JSON.stringify(started);
  for (const status of ['starting', 'running', 'verifying']) {
    assert.equal(agentActivityRunning(started, indexBotWork([session('child', status)], true)), true);
  }
  for (const status of ['completed', 'cancelled', 'failed', 'result_ready', 'paused', 'queued', 'waiting_user', 'waiting_agent', 'stopping', 'awaiting_outcome']) {
    const work = indexBotWork([session('child', status), session('another-child', 'running')], true);
    assert.equal(agentActivityRunning(started, work), false, status);
  }
  assert.equal(JSON.stringify(started), before, 'the original started event remains intact');
});

test('unavailable or missing current facts never replay a historic running animation', () => {
  const started = activity('start', 'child', undefined, 'started').agentActivity!;
  assert.equal(agentActivityRunning(started, indexBotWork([session('child', 'running')], false)), false);
  assert.equal(agentActivityRunning(started, indexBotWork([session('another-child', 'running')], true)), false);
  const work = indexBotWork([session('child', 'running')], true);
  for (const state of ['reported', 'ended', 'cancelled', 'question', 'blocked']) {
    assert.equal(agentActivityRunning(activity(state, 'child', undefined, state).agentActivity!, work), true, 'current execution facts supersede the historical event');
  }
});

test('one stable Agent slot updates across replies while raw history and independent Agents remain intact', () => {
  const source = [activity('report'), activity('result-ready'), activity('other', 'other'),
    activity('later', 'child', '2026-10-21T00:01:00Z'), activity('ended', 'child', '2026-10-21T00:01:00Z', 'ended')];
  const before=JSON.stringify(source);
  assert.deepEqual(visibleBotMessages(source).map(row => row.id), ['report', 'other']);
  assert.equal(visibleBotMessages(source)[0]!.agentActivity!.state,'ended');
  assert.equal(JSON.stringify(source),before);
  assert.equal(source.length, 5);
  const reply = normalizeBotMessage({ id: 'reply', kind: 'agent_reply', content: '进展' })!;
  assert.equal(visibleBotMessages([activity('a'), reply, activity('b')]).length, 2);
  assert.equal(visibleBotMessages([activity('a', 'child', ''), activity('b', 'child', '')]).length, 1);
  assert.equal(visibleBotMessages([activity('a', 'child', undefined, 'question'), activity('b', 'child', undefined, 'question')]).length, 1);
});

test('Agent identity and reading anchor survive loading an earlier source event',()=>{
  const first={type:'message' as const,message:activity('newer')},earlier={type:'message' as const,message:activity('earlier')};
  assert.equal(conversationRowKey(first),conversationRowKey(earlier));
  assert.equal(conversationRowKey(first),agentActivityPresentationId(first.message.agentActivity!));
  assert.equal(conversationWindowAnchor([first],[earlier],0),0);
  assert.equal(currentAgentActivity(first.message.agentActivity!,indexBotWork([session('child','verifying')],true)).state,'verifying');
  assert.equal(currentAgentActivity(first.message.agentActivity!,indexBotWork([session('child','result_ready')],true)).state,'reported');
});

test('agent identity is stable and varies both SVG shape and tone across independent sessions', () => {
  const first = agentIdentity('rc-work-1'), second = agentIdentity('rc-work-2');
  assert.deepEqual(agentIdentity('rc-work-1'), first);
  assert.notEqual(first.icon, second.icon);
  const identities = Array.from({ length: 64 }, (_, i) => agentIdentity(`agent-${i}`));
  assert.ok(new Set(identities.map(row => row.icon)).size >= 6);
  assert.equal(new Set(identities.map(row => row.tone)).size, 4);
});

test('internal verification progress remains validated without becoming a main conversation row', () => {
  const verificationProgress = { continuationId: 'review', startedAt: '2026-10-21T00:00:00Z',
    lastProgressAt: '2026-10-21T00:01:00Z', observationCount: 7, phase: 'ready' };
  const row = (id: string, count: number) => ({ id, kind: 'agent_activity',
    agentActivity: readAgentActivity({ eventId: id, sessionId: 'child', name: '独立核验', state: 'verifying',
      verificationProgress: { ...verificationProgress, observationCount: count } }) });
  const source = [row('first', 0), row('next', 7)];
  const before = JSON.stringify(source);
  assert.deepEqual(coalesceAgentActivity(source).map(row => row.id), ['first']);
  assert.equal(coalesceAgentActivity(source)[0]!.agentActivity?.verificationProgress?.observationCount,7);
  assert.equal(source[1]!.agentActivity?.verificationProgress?.observationCount, 7);
  assert.equal(row('bad', -1).agentActivity?.verificationProgress, undefined);
  assert.equal(normalizeBotMessage(source[1]), null);
  assert.equal(JSON.stringify(source), before, 'raw verification facts remain intact for details');
  assert.equal(visibleBotMessages([activity('failed', 'child', undefined, 'blocked')]).length, 1);
});
