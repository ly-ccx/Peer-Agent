import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity, TaskOverviewItem } from '@peer-agent/protocol';
import { normalizeBotMessage } from './botConversationState.ts';
import { indexBotWork } from './botWorkState.ts';
import { readDrawerSession } from './drawerState.ts';
import { workPanelActivity, workPanelMaterials, workPanelNeedsUser, workPanelSessions } from './botWorkPanelState.ts';

const session = (sessionId: string, parentSessionId?: string, status = 'running') => readDrawerSession({
  sessionId, planId: `plan-${sessionId}`, title: `Task ${sessionId}`, status,
  origin: { anchorMessageId: 'input-1', ...(parentSessionId ? { parentSessionId } : {}) },
})!;
const overview = (id: string, openPath?: string): TaskOverviewItem => ({
  taskId: `plan-${id}`, source: 'goal_plan', actionRight: 'peer_advancing', nextAction: 'none',
  title: `Task ${id}`, statusLabel: 'Running', actionLabel: '', planSteps: [{ taskId: 'step', title: 'Create file', status: 'completed',
    artifacts: [{ ref: `artifact-${id}`, kind: 'file', label: 'result.md', actionLabel: 'Open', ...(openPath ? { openPath } : {}) }] }],
});

test('tasks and returned child Agents retain their explicit parent relation', () => {
  const parent = session('parent'), child = session('child', 'parent'), returned = session('returned', 'parent', 'accepted');
  const index = indexBotWork([parent, child, returned, session('unrelated', undefined, 'accepted')], true);
  assert.equal(child.parentSessionId, 'parent');
  assert.deepEqual(workPanelSessions(index).tasks.map(row => row.sessionId), ['parent']);
  assert.deepEqual(workPanelSessions(index).agents.map(row => row.sessionId), ['parent', 'child', 'returned']);
  assert.deepEqual(workPanelSessions({ ...index, available: false }), { tasks: [], agents: [], obligations: [] });
});

test('only the host follow-up owner can turn a technical result into a human request', () => {
  const result = session('result', undefined, 'result_ready');
  assert.equal(workPanelNeedsUser({ ...result, followUp: { owner: 'bot', inCurrentList: true, reason: 'awaiting_acceptance_technical' } }), false);
  assert.equal(workPanelNeedsUser({ ...result, followUp: { owner: 'user', inCurrentList: true, reason: 'awaiting_human_gate' } }), true);
});

test('attention comes from running public activity rather than completed text', () => {
  const activity: ProjectAgentActivity = { workspaceId: 'bot', conversationId: 'conversation', turnId: 'turn',
    revision: 1, startedAt: '2026-11-01T00:00:00Z', phase: 'tool', replyTo: [], replyText: '', segments: [] };
  assert.equal(workPanelActivity([{ type: 'activity', activity }]), activity);
  assert.equal(workPanelActivity([{ type: 'activity', activity: { ...activity, phase: 'done', replyText: 'Still working' } }]), undefined);
  assert.equal(workPanelActivity([]), undefined);
});

test('material scope keeps identical paths in separate task contexts separate', () => {
  const index = indexBotWork([session('one'), session('two')], true);
  const materials = workPanelMaterials('bot', index, [overview('one', '/workspace/result.md'), overview('two', '/workspace/result.md')], []);
  assert.equal(materials.length, 2);
  assert.deepEqual(materials.map(row => row.reference?.task?.sessionId), ['one', 'two']);
  assert.equal(new Set(materials.map(row => row.id)).size, 2);
});

test('registered output survives later reads; prose paths never create materials', () => {
  const index = indexBotWork([], true);
  const written = normalizeBotMessage({ id: 'one', kind: 'agent_reply', role: 'assistant', content: '/workspace/imagined.png',
    resourceReferences: [{ path: '/workspace/result.md', tool: 'write_file' }] })!;
  const read = normalizeBotMessage({ id: 'two', kind: 'agent_reply', role: 'assistant',
    resourceReferences: [{ path: '/workspace/result.md', tool: 'read_file' }] })!;
  const materials = workPanelMaterials('bot', index, [], [written, read]);
  assert.equal(materials.length, 1);
  assert.equal(materials[0].source, 'output');
  assert.equal(materials[0].reference?.path, '/workspace/result.md');
});

test('artifacts without a confirmed path retain preview provenance without inventing a file', () => {
  const index = indexBotWork([session('one')], true);
  const material = workPanelMaterials('bot', index, [overview('one')], [])[0];
  assert.equal(material.reference, undefined);
  assert.equal(material.sessionId, 'one');
  assert.equal(material.source, 'artifact');
});

test('a local persistence blocker retains the host Bot responsibility through the drawer and current work projection', () => {
  const row = readDrawerSession({ sessionId: 'local', planId: 'plan', status: 'failed',
    followUp: { owner: 'bot', inCurrentList: true, reason: 'local_persistence_failed' }, origin: { anchorMessageId: 'input' } })!;
  assert.equal(row.followUp?.reason, 'local_persistence_failed');
  assert.equal(workPanelNeedsUser(row), false);
  const current = workPanelSessions(indexBotWork([row], true));
  assert.equal(current.tasks.some(task => task.sessionId === 'local'), true);
});
