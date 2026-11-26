import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity, ProjectObjectiveView, TaskOverviewItem } from '@peer-agent/protocol';
import { normalizeBotMessage } from './botConversationState.ts';
import { indexBotWork } from './botWorkState.ts';
import { readDrawerSession } from './drawerState.ts';
import {
  workPanelActivity,
  workPanelCards,
  workPanelGroups,
  workPanelMaterialSections,
  workPanelMaterials,
  workPanelNeedsUser,
} from './botWorkPanelState.ts';

const session = (sessionId: string, parentSessionId?: string, status = 'running') => readDrawerSession({
  sessionId, planId: `plan-${sessionId}`, title: `Task ${sessionId}`, status,
  origin: { anchorMessageId: 'input-1', ...(parentSessionId ? { parentSessionId } : {}) },
})!;
const overview = (id: string, openPath?: string): TaskOverviewItem => ({
  taskId: `plan-${id}`, source: 'goal_plan', actionRight: 'peer_advancing', nextAction: 'none',
  title: `Task ${id}`, statusLabel: 'Running', actionLabel: '', planSteps: [{ taskId: 'step', title: 'Create file', status: 'completed',
    artifacts: [{ ref: `artifact-${id}`, kind: 'file', label: 'result.md', actionLabel: 'Open', ...(openPath ? { openPath } : {}) }] }],
});

test('one tree groups all four states; a child in a different lane never duplicates its parent', () => {
  const index = indexBotWork([session('parent'), session('child', 'parent'), session('blocked', 'child', 'failed'),
    session('queued', 'parent', 'queued'), session('returned', 'parent', 'accepted')], true);
  const groups = workPanelGroups(index);
  assert.deepEqual(groups.map(({ lane, count }) => [lane, count]), [['needsYou', 1], ['doing', 2], ['todo', 1], ['delivered', 1]]);
  assert.deepEqual(groups.map(group => group.roots.map(node => node.id)), [
    ['session:blocked'], ['session:parent'], ['session:queued'], ['session:returned'],
  ]);
  assert.deepEqual(groups[1].roots[0].children.map(node => node.id), ['session:child']);
  assert.deepEqual(workPanelGroups({ ...index, available: false }), []);
});

test('no matters yields an empty board and a queued task does not create empty groups', () => {
  assert.deepEqual(workPanelGroups(indexBotWork([], true)), []);
  assert.deepEqual(workPanelGroups(indexBotWork([session('queued', undefined, 'queued')], true)).map(group => group.lane), ['todo']);
});

test('active goals join queued work unless already represented by a current session', () => {
  const objective = (objectiveId: string, status: ProjectObjectiveView['status']): ProjectObjectiveView => ({
    objectiveId, status, workspaceId: 'bot', projectAgentConversationId: 'conversation', originMessageId: 'input',
    title: objectiveId, outcome: '', successSignals: [], milestones: [], autonomy: 'report_only', watches: [],
    budget: { maxAutoSessionsPerDay: 0, maxProbeRunsPerDay: 0 }, createdBy: 'user_request', createdAt: '', updatedAt: '', version: 1,
  });
  const index = indexBotWork([{ ...session('working'), objectiveId: 'linked' }, session('queued', undefined, 'queued')], true);
  const groups = workPanelGroups(index, [objective('linked', 'active'), objective('next', 'active'), objective('paused', 'paused')]);
  assert.deepEqual(groups.map(({ lane, count }) => [lane, count]), [['doing', 1], ['todo', 2]]);
  assert.deepEqual(groups[1].roots.map(node => node.id), ['session:queued', 'objective:next']);
});

test('pending questions and approvals link back to their source; resolved cards disappear', () => {
  const card = (cardId: string, kind: string, sessionId?: string, resolvedState?: string) => ({
    cardId, kind, content: cardId, refs: { sessionId }, resolvedState, actions: [{ id: 'respond', kind: 'answer', label: 'Respond' }],
  });
  const messages = [normalizeBotMessage({ id: 'question-message', kind: 'agent_reply', role: 'assistant', cards: [
    card('question', 'question', 'child'), card('approval', 'approval'), card('settled', 'approval'),
  ] })!, normalizeBotMessage({ id: 'receipt', kind: 'agent_reply', role: 'assistant', cards: [card('settled', 'approval', undefined, 'resolved')] })!];
  const cards = workPanelCards(messages);
  assert.deepEqual(cards.map(({ cardId, messageId }) => [cardId, messageId]), [['question', 'question-message'], ['approval', 'question-message']]);
  const index = indexBotWork([session('parent'), session('child', 'parent'), session('old', undefined, 'failed')], true);
  const [needs, doing] = workPanelGroups(index, [], [{ grantId: 'grant', items: [{ sessionId: 'old' }] }], cards);
  assert.deepEqual(needs.roots.map(node => node.id), ['grant:grant', 'session:child', 'card:approval']);
  assert.equal(doing.count, 1);
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

test('formal artifacts and written files are separate from process-only reads', () => {
  const read = normalizeBotMessage({ id: 'files', kind: 'agent_reply', role: 'assistant', resourceReferences: [
    { path: 'notes.md', tool: 'read_file' }, { path: 'changed.md', tool: 'edit_file' },
  ] })!;
  const sections = workPanelMaterialSections(workPanelMaterials('bot', indexBotWork([session('one')], true), [overview('one')], [read]));
  assert.deepEqual(sections.outputs.map(item => item.source).sort(), ['artifact', 'output']);
  assert.deepEqual(sections.references.map(item => item.label), ['notes.md']);
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
  const current = workPanelGroups(indexBotWork([row], true));
  assert.equal(current[0].lane, 'needsYou');
  assert.equal(current[0].roots[0].id, 'session:local');
});
