import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBatchSearchView, lanePhaseLabel } from './batchSearchLaneView.ts';

test('running state: no result yet → lanes from args.queries shown as running', () => {
  const view = buildBatchSearchView(
    { queries: [{ id: 'a', label: 'lane A', query: 'foo' }, { query: 'bar' }] },
    undefined,
  );
  assert.equal(view.status, 'running');
  assert.equal(view.lanes.length, 2);
  assert.equal(view.lanes[0].laneId, 'a');
  assert.equal(view.lanes[0].label, 'lane A');
  assert.equal(view.lanes[0].phase, 'running');
  assert.equal(view.lanes[1].laneId, 'lane-2');
  assert.equal(view.lanes[1].phase, 'running');
});

test('completed state: result.lanes overrides base lanes by laneId (latest wins)', () => {
  const result = JSON.stringify({
    status: 'success',
    lanes: [
      { id: 'a', status: 'completed', matchCount: 3 },
      { id: 'b', status: 'completed', matchCount: 0 },
    ],
    aggregated: {
      totalUniqueMatches: 3,
      truncated: false,
      matches: [{ path: 'x.ts', line: 1, text: 'hit', hitCount: 1, laneIds: ['a'] }],
    },
  });
  const view = buildBatchSearchView(
    { queries: [{ id: 'a', label: 'lane A', query: 'foo' }, { id: 'b', label: 'lane B', query: 'bar' }] },
    result,
  );
  assert.equal(view.status, 'success');
  const a = view.lanes.find((l) => l.laneId === 'a');
  assert.equal(a?.phase, 'completed');
  assert.equal(a?.resultCount, 3);
  assert.equal(a?.label, 'lane A'); // base label preserved
  assert.equal(view.aggregate?.totalUniqueMatches, 3);
  assert.equal(view.aggregate?.matches[0].path, 'x.ts');
});

test('wrapped result: outputPreview envelope drills down and completed→success', () => {
  // 后端能力包裹层：真实 lanes/aggregated/status 在 outputPreview 内层，
  // 且 envelope.status 为 'completed'。回归用例守护「lane 卡死在 searching」。
  const result = JSON.stringify({
    kind: 'local_capability_result_ref',
    tool: 'batch_search',
    status: 'completed',
    outputPreview: {
      status: 'success',
      lanes: [
        { id: 'a', status: 'completed', matchCount: 3 },
        { id: 'b', status: 'completed', matchCount: 0 },
      ],
      aggregated: {
        totalUniqueMatches: 3,
        truncated: false,
        matches: [{ path: 'x.ts', line: 1, text: 'hit', hitCount: 1, laneIds: ['a'] }],
      },
    },
  });
  const view = buildBatchSearchView(
    { queries: [{ id: 'a', label: 'lane A', query: 'foo' }, { id: 'b', label: 'lane B', query: 'bar' }] },
    result,
  );
  assert.equal(view.status, 'success');
  const a = view.lanes.find((l) => l.laneId === 'a');
  assert.equal(a?.phase, 'completed');
  assert.equal(a?.resultCount, 3);
  assert.equal(view.aggregate?.totalUniqueMatches, 3);
});

test('bare envelope status completed (no inner status) normalizes to success', () => {
  // 兜底：历史「裸结构」可能直接以 completed 表达终态而无内层 success。
  const result = {
    status: 'completed',
    lanes: [{ id: 'a', status: 'completed', matchCount: 1, query: 'q' }],
    aggregated: { totalUniqueMatches: 1, matches: [] },
  };
  const view = buildBatchSearchView({ queries: [{ id: 'a', query: 'q' }] }, result);
  assert.equal(view.status, 'success');
  assert.equal(view.lanes[0].phase, 'completed');
});

test('partial state: failed lane carries errorMessage', () => {
  const result = {
    status: 'partial',
    lanes: [
      { id: 'a', status: 'completed', matchCount: 2 },
      { id: 'b', status: 'failed', matchCount: 0, errorMessage: 'boom' },
    ],
    aggregated: { totalUniqueMatches: 2, truncated: false, matches: [] },
  };
  const view = buildBatchSearchView({ queries: [{ id: 'a', query: 'x' }, { id: 'b', query: 'y' }] }, result);
  assert.equal(view.status, 'partial');
  const b = view.lanes.find((l) => l.laneId === 'b');
  assert.equal(b?.phase, 'failed');
  assert.equal(b?.errorMessage, 'boom');
});

test('blocked state surfaces as blocked status', () => {
  const view = buildBatchSearchView(
    { queries: [{ id: 'a', query: 'x' }] },
    JSON.stringify({ status: 'blocked', reason: 'queries must be a non-empty array' }),
  );
  assert.equal(view.status, 'blocked');
});

test('lane appearing only in result (not in args) is still included', () => {
  const view = buildBatchSearchView(
    { queries: [] },
    { status: 'success', lanes: [{ id: 'z', status: 'completed', matchCount: 1, query: 'q' }], aggregated: { totalUniqueMatches: 1, matches: [] } },
  );
  assert.equal(view.lanes.length, 1);
  assert.equal(view.lanes[0].laneId, 'z');
});

test('malformed result string degrades gracefully to running', () => {
  const view = buildBatchSearchView({ queries: [{ id: 'a', query: 'x' }] }, 'not-json{');
  assert.equal(view.status, 'running');
  assert.equal(view.lanes[0].phase, 'running');
});

test('lanePhaseLabel localizes completed phase', () => {
  assert.equal(lanePhaseLabel('completed', true), '已检索');
  assert.equal(lanePhaseLabel('completed', false), 'done');
  assert.equal(lanePhaseLabel('running', true), '检索中');
});
