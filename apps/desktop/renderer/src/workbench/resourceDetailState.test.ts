import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceDetailKey, resourceDetailReturnLabel, sameResourceDetail } from './resourceDetailState.ts';
import { botDetailReference } from '../project-agent/drawer/botDetailReference.ts';

test('detail identity is scoped by Bot and domain ID, independently of labels and task status', () => {
  const task = { workspaceId: 'A', kind: 'task' as const, sessionId: 'work' };
  assert.equal(sameResourceDetail(task, { ...task }), true);
  assert.equal(sameResourceDetail(task, { ...task, workspaceId: 'B' }), false);
  assert.equal(sameResourceDetail(task, { ...task, sessionId: 'other' }), false);
  assert.notEqual(resourceDetailKey(task), resourceDetailKey({ workspaceId: 'A', kind: 'reply', replyId: 'work' }));
  assert.equal(resourceDetailReturnLabel(task, true), '返回任务');
  assert.equal(sameResourceDetail({ workspaceId: 'A', kind: 'evidence', evidenceRef: 'e', replyId: 'one' },
    { workspaceId: 'A', kind: 'evidence', evidenceRef: 'e', replyId: 'two' }), false);
});

test('the existing domain state selects Bot information, task, reply, evidence and process without executing anything', () => {
  const memory = { open: true, tab: 'settings' as const, sessionId: null };
  assert.equal(botDetailReference('A', memory, null).kind, 'bot');
  assert.deepEqual(botDetailReference('A', { ...memory, tab: 'tasks', sessionId: 'work' }, null), { workspaceId: 'A', kind: 'task', sessionId: 'work' });
  assert.equal(botDetailReference('A', memory, { replyId: 'reply', evidence: null, rounds: null }).kind, 'reply');
  assert.equal(botDetailReference('A', memory, { evidence: null, rounds: [] }).kind, 'process');
  const evidence: any = { evidenceRef: 'record-1', ok: true };
  assert.deepEqual(botDetailReference('A', memory, { replyId: 'reply', evidence, rounds: null }),
    { workspaceId: 'A', kind: 'evidence', evidenceRef: 'record-1', replyId: 'reply' });
});
