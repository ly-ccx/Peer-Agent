import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedShellTask } from '@peer-agent/protocol';
import { orderBackgroundRuns, visibleBackgroundRuns, backgroundRunSource, reconcileStopRequest, backgroundReadPresentation } from './backgroundRuntimeState.ts';

const run = (id: string, status = 'running', source: string | null = 'current'): ManagedShellTask => ({ taskId: id, command: 'service', cwd: '/project', status, runInBackground: true, conversationId: source });
for (const [state, status] of [['E', null], ['R', 'running'], ['S', 'stopping'], ['F', 'failed'], ['D', 'success']] as const) {
  for (const [context, source] of [['C', 'current'], ['O', 'other'], ['N', null]] as const) {
    test(`${state}-${context}: global snapshot survives source context without implicit filtering`, () => {
      const snapshot = status ? [run('target', status, source)] : [];
      const ordered = orderBackgroundRuns(snapshot);
      assert.deepEqual(ordered, snapshot);
      const view = visibleBackgroundRuns(ordered, []);
      assert.equal(view.primary.length, status && status !== 'success' ? 1 : 0);
      assert.equal(view.history.length, 0, 'history is collapsed by default');
      assert.equal(view.historyCount, status === 'success' ? 1 : 0);
      if (snapshot[0]) {
        assert.equal(ordered[0], snapshot[0], 'use the actual snapshot record');
        const provenance = backgroundRunSource(snapshot[0], [{ id: 'current', title: 'Current' }, { id: 'other', title: 'Other' }], false);
        assert.equal(provenance.id, source);
      }
    });
  }
}
test('E-O: runs from elsewhere prevent false global empty state', () => {
  assert.equal(orderBackgroundRuns([run('elsewhere', 'running', 'other')]).length, 1);
});
test('stable order preserves ended row while replacing it with latest snapshot', () => {
  const first = orderBackgroundRuns([run('b'), run('a', 'failed')]);
  assert.deepEqual(first.map((r) => r.taskId), ['a', 'b']);
  const ended = run('b', 'success');
  const next = orderBackgroundRuns([ended, run('a', 'failed')], first.map((r) => r.taskId));
  assert.equal(next[1], ended);
  assert.equal(visibleBackgroundRuns(next, ['a', 'b']).primary.length, 2);
  assert.equal(visibleBackgroundRuns(next, []).historyCount, 1);
});
test('foreground and removed records are never retained as UI runtime truth', () => {
  assert.deepEqual(orderBackgroundRuns([{ ...run('fg'), runInBackground: false }], ['missing']), []);
});
test('deleted source differs from failed source lookup and unknown provenance', () => {
  assert.equal(backgroundRunSource(run('a'), [], true).label, '来源任务已删除');
  assert.equal(backgroundRunSource(run('a'), null, true).label, '来源暂不可用');
  assert.equal(backgroundRunSource(run('a', 'running', null), [], true).label, '来源未知');
});
test('read failure is never an empty-state success and preserves stale-data distinction', () => {
  assert.equal(backgroundReadPresentation(false, 'denied'), 'error');
  assert.equal(backgroundReadPresentation(true, 'failed'), 'stale');
  assert.equal(backgroundReadPresentation(false, null), 'loading');
  assert.equal(backgroundReadPresentation(true, null), 'ready');
});
for (const phase of ['confirm', 'requesting', 'unconfirmed', 'rejected'] as const) {
  test(`stop ${phase}: no optimistic terminal state; natural exit clears request`, () => {
    const request = { taskId: 'target', phase };
    assert.equal(reconcileStopRequest(request, [run('target')]), request);
    assert.equal(reconcileStopRequest(request, [run('target', 'success')]), null);
    assert.equal(reconcileStopRequest(request, [run('target', 'stopping')]), null);
    assert.equal(reconcileStopRequest(request, [run('other', 'success')]), request, 'another run cannot confirm this stop');
  });
}
