import assert from 'node:assert/strict';
import test from 'node:test';

import { diffWatchObservation, type WatchObservation } from './objectives.ts';

const observation: WatchObservation = {
  objectiveId: 'obj-1',
  watchId: 'watch-1',
  observedAt: '2026-09-26T00:00:00.000Z',
  digest: 'abc',
  summary: '主干变了',
  evidenceRefs: ['ev-1'],
  severity: 'notable',
  changed: false,
};

test('the first watch observation is a change', () => {
  const next = diffWatchObservation(null, { ...observation, changed: false });
  assert.equal(next.changed, true);
});

test('a watch changes only when the digest changes', () => {
  const same = diffWatchObservation(observation, { ...observation, changed: true, summary: '探针说变了' });
  assert.equal(same.changed, false);
  assert.equal(same.summary, '探针说变了');

  const different = diffWatchObservation(observation, {
    ...observation,
    digest: 'def',
    changed: false,
  });
  assert.equal(different.changed, true);
});
