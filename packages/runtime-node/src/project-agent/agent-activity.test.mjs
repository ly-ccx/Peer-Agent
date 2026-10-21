import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createAgentEventPublisher } from './agent-activity.mjs';
import { mapDelegationEvents } from './event-mapper.mjs';

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

test('a later report remains visible and verification never borrows the returned-result label', t => {
  const f = fixture(t), publish = f.publisher();
  publish('ws', [
    { eventId: 'report-1', kind: 'report_available', sessionId: 'child' },
    { eventId: 'verify-failed', kind: 'result_ready', sessionId: 'child', payload: { outcome: 'failed' } },
    { eventId: 'repair', kind: 'report_available', sessionId: 'child', payload: { owner: 'parent_agent', status: 'waiting_agent' } },
    { eventId: 'report-2', kind: 'report_available', sessionId: 'child' },
    { eventId: 'verify-passed', kind: 'result_ready', sessionId: 'child', payload: { outcome: 'passed' } },
    { eventId: 'accepted', kind: 'session_ended', sessionId: 'child' },
  ]);
  assert.deepEqual(f.activities().map(row => row.state), ['reported', 'blocked', 'reported', 'verified', 'ended']);
  assert.equal(f.inbox.takeBatch('ws').events.length, 6);
});
