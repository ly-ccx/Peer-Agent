import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTaskDetail, settleTaskReport } from './taskDetailState.ts';
import { readDrawerSession } from './drawerState.ts';

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
