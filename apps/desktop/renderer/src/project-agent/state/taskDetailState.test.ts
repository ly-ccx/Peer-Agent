import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTaskDetail } from './taskDetailState.ts';
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
