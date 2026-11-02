import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTaskDetail, settleTaskReport, taskProgressPreview } from './taskDetailState.ts';
import { createI18n } from '@peer-agent/i18n';
import type { TaskConversationContext } from './taskConversationState';
import { readDrawerSession } from './drawerState.ts';

test('verification belongs to its task and source revision; report retention cannot revive a stale pass', () => {
  const verification = { sessionId: 'work', outcome: 'passed', checks: [], reviewAttempts: [], outputs: [] };
  const detail = readDrawerSession({ sessionId: 'work', sourceRevision: 'source-1', observationRevision: 'review-1', report: { verification } })!;
  const selected = readDrawerSession({ sessionId: 'work', sourceRevision: 'source-1', observationRevision: 'review-1' })!;
  assert.equal(mergeTaskDetail(selected, detail)!.verification?.outcome, 'passed');
  assert.equal(mergeTaskDetail({ ...selected, sourceRevision: 'source-2' }, detail)!.verification, undefined);
  assert.equal(mergeTaskDetail({ ...selected, observationRevision: 'review-2' }, detail)!.verification, undefined);
  assert.equal(readDrawerSession({ sessionId: 'other', report: { verification } })!.verification, undefined);
  assert.equal(readDrawerSession({ sessionId: 'work', report: { verification: { ...verification, outcome: 'invented' } } })!.verification, undefined);
});

test('a compact list cannot hide a fetched report or overwrite its evidence', () => {
  const selected = readDrawerSession({ sessionId: 'work', status: 'running' })!;
  const detail = readDrawerSession({ sessionId: 'work', status: 'queued', report: { summary: 'Read the project files', evidenceRefs: ['actual'] } })!;
  const merged = mergeTaskDetail(selected, detail)!;
  assert.equal(merged.status, 'running');
  assert.equal(merged.summary, 'Read the project files');
  assert.deepEqual(merged.evidenceRefs, ['actual']);
});
test('another task report never leaks into a newly selected task', () => {
  const selected = readDrawerSession({ sessionId: 'new', status: 'running' })!;
  const detail = readDrawerSession({ sessionId: 'old', report: { summary: 'Other work' } })!;
  assert.equal(mergeTaskDetail(selected, detail), selected);
  assert.equal(mergeTaskDetail(null, detail), detail);
  assert.equal(mergeTaskDetail(null, null), null);
});
test('read failures preserve a matching report, while deletion and foreign replies cannot restore it', () => {
  const old = readDrawerSession({ sessionId: 'old', report: { summary: 'Previous report' } })!;
  assert.deepEqual(settleTaskReport('old', null, old), { detail: old, state: 'unavailable' });
  assert.deepEqual(settleTaskReport('old', { ok: false, code: 'NOT_FOUND' }, old), { detail: null, state: 'unavailable' });
  assert.equal(settleTaskReport('new', { ok: true, session: old }, old).detail, null);
  assert.equal(settleTaskReport('old', { ok: true, session: { sessionId: 'old', status: 'running' } }, old).state, 'ready');
});

test('compact progress keeps current stop and resource blockers ahead of an old successful note', () => {
  const i18n = createI18n('zh-CN');
  const note: TaskConversationContext = { workspaceId: 'w', sessionId: 'work', messageId: 'reply',
    content: 'Earlier result is ready', createdAt: '2026-10-29T00:00:00Z', question: null };
  for (const status of ['cancelled', 'stopping', 'awaiting_outcome']) {
    const session = readDrawerSession({ sessionId: 'work', status })!;
    assert.notEqual(taskProgressPreview(session, note, i18n), note.content);
  }
  const queued = readDrawerSession({ sessionId: 'work', status: 'queued', resourceBlocker: {
    kind: 'protection', code: 'execution_stop_unconfirmed', resourceRef: 'directory:/synthetic', claimId: 'claim',
  } })!;
  assert.equal(taskProgressPreview(queued, note, i18n), i18n.t('projectAgent.drawer.resourceStopUnconfirmed'));
});

test('compact progress uses a matching reply, not task instructions or another task report', () => {
  const i18n = createI18n('zh-CN');
  const session = readDrawerSession({ sessionId: 'work', status: 'running', report: { taskBrief: 'Implement this goal' } })!;
  const note: TaskConversationContext = { workspaceId: 'w', sessionId: 'work', messageId: 'reply',
    content: 'Draft saved.\nIndependent review remains pending.', createdAt: '2026-10-29T00:00:00Z', question: null };
  assert.equal(taskProgressPreview(session, note, i18n), i18n.t('projectAgent.drawer.task.progressNote', { content: 'Draft saved. Independent review remains pending.' }));
  assert.equal(taskProgressPreview(session, { ...note, sessionId: 'other' }, i18n), i18n.t('projectAgent.drawer.task.progressPending'));
  assert.equal(taskProgressPreview(session, null, i18n), i18n.t('projectAgent.drawer.task.progressPending'));
});
