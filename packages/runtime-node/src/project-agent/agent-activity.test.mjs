import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createAgentEventPublisher } from './agent-activity.mjs';
import { mapDelegationEvents } from './event-mapper.mjs';
import { createWatchPublisher } from './watch-publisher.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-activity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const parent = store.createConversation({ role: 'project_agent', workspaceId: 'ws', title: 'Bot' });
  const plan = { title: '实现检查', delegationOrigin: { parentConversationId: parent.id, workspaceId: 'ws', sessionId: 'child' } };
  const inbox = createProjectInbox({ rootDir: root });
  const publisher = () => createAgentEventPublisher({ inbox, conversationStore: store, findSession: () => plan });
  const activities = () => store.getPersistedConversationHistory(parent.id).messages.map(row => row.agentActivity);
  return { publisher, activities, inbox };
}

test('report and result-ready without a verdict retain both inbox facts but publish one report activity', t => {
  const f = fixture(t);
  const prior = { sessionId: 'child', workspaceId: 'ws', status: 'running' };
  const next = { ...prior, status: 'result_ready', reportRevision: 'report-1', resultRevision: 'result-1' };
  const events = mapDelegationEvents({ sessions: [prior] }, { sessions: [next] }, { now: '2026-10-21T00:00:00Z' });
  assert.deepEqual(events.map(event => event.kind), ['report_available', 'result_ready']);
  f.publisher()('ws', events);
  f.publisher()('ws', events);
  assert.deepEqual(f.activities().map(row => row.state), ['reported']);
  assert.equal(f.inbox.takeBatch('ws').events.length, 2);
});

test('reports remain visible while verification results stay in the inbox for task facts and bot reporting', t => {
  const f = fixture(t), publish = f.publisher();
  publish('ws', [
    { eventId: 'report-1', kind: 'report_available', sessionId: 'child' },
    { eventId: 'verify-failed', kind: 'result_ready', sessionId: 'child', payload: { outcome: 'failed' } },
    { eventId: 'repair', kind: 'report_available', sessionId: 'child', payload: { owner: 'parent_agent', status: 'waiting_agent' } },
    { eventId: 'report-2', kind: 'report_available', sessionId: 'child' },
    { eventId: 'verify-passed', kind: 'result_ready', sessionId: 'child', payload: { outcome: 'passed' } },
    { eventId: 'accepted', kind: 'session_ended', sessionId: 'child' },
  ]);
  assert.deepEqual(f.activities().map(row => row.state), ['reported', 'reported', 'ended']);
  assert.equal(f.inbox.takeBatch('ws').events.length, 6);
});

test('verification retains throttled task progress and stall wakes without adding public messages', t => {
  const f = fixture(t), publish = f.publisher();
  let clock = Date.parse('2026-10-21T00:00:00Z');
  const watch = createWatchPublisher({ now: () => new Date(clock).toISOString() });
  const verificationProgress = { continuationId: 'review', startedAt: new Date(clock).toISOString(),
    lastProgressAt: new Date(clock).toISOString(), observationCount: 0, phase: 'requesting' };
  const session = { sessionId: 'child', workspaceId: 'ws', status: 'verifying', verificationProgress };
  const emit = () => { const events = watch.publish('ws', { sessions: [session] }); publish('ws', events); return events; };
  assert.equal(emit().filter(event => event.kind === 'session_progress').length, 1);
  clock += 10_000;
  session.verificationProgress = { ...verificationProgress, observationCount: 7, lastProgressAt: new Date(clock).toISOString() };
  assert.equal(emit().length, 0);
  clock += 20_000;
  const progress = emit();
  assert.equal(progress.length, 1);
  assert.equal(progress[0].payload.verificationProgress.observationCount, 7);
  assert.deepEqual(f.activities(), []);
  assert.equal(emit().length, 0);
  clock += 10 * 60_000;
  assert.equal(emit().filter(event => event.kind === 'stalled').length, 1);
  assert.equal(emit().length, 0);
  const events = f.inbox.diagnosticSnapshot('ws').events;
  assert.equal(events.filter(event => event.kind === 'session_progress').length, 2);
  assert.equal(events.filter(event => event.kind === 'session_progress').at(-1).payload.verificationProgress.observationCount, 7);
  assert.equal(events.filter(event => event.kind === 'stalled').length, 1);
});
