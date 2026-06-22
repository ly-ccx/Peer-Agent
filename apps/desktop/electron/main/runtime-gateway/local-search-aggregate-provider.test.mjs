import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLocalSearchAggregateProvider,
  __testables,
} from './local-search-aggregate-provider.mjs';

const { normalizeQueries, aggregateMatches, overallStatus, runWithConcurrency, clamp } = __testables;

test('normalizeQueries rejects empty / too many / invalid kind', () => {
  assert.equal(normalizeQueries(undefined).error?.length > 0, true);
  assert.equal(normalizeQueries([]).error?.length > 0, true);
  assert.equal(normalizeQueries(new Array(9).fill({ query: 'x' })).error?.length > 0, true);
  assert.equal(normalizeQueries([{ query: '' }]).error?.length > 0, true);
  assert.equal(normalizeQueries([{ query: 'x', kind: 'semantic' }]).error?.length > 0, true);
});

test('normalizeQueries assigns stable lane ids and dedups collisions', () => {
  const { lanes, error } = normalizeQueries([
    { id: 'a', query: 'foo' },
    { id: 'a', query: 'bar' },
    { query: 'baz' },
  ]);
  assert.equal(error, undefined);
  assert.equal(lanes.length, 3);
  assert.equal(lanes[0].laneId, 'a');
  assert.notEqual(lanes[1].laneId, 'a'); // collision resolved
  assert.equal(lanes[2].laneId, 'lane-3');
});

test('aggregateMatches dedupes by path:line and ranks by hitCount', () => {
  const laneResults = [
    { id: 'l1', matches: [{ path: 'a.ts', line: 1, text: 'x' }, { path: 'b.ts', line: 2, text: 'y' }] },
    { id: 'l2', matches: [{ path: 'a.ts', line: 1, text: 'x' }] },
  ];
  const { matches, totalUniqueMatches } = aggregateMatches(laneResults, { dedupe: true, cap: 100 });
  assert.equal(totalUniqueMatches, 2);
  // a.ts:1 hit by 2 lanes → ranked first
  assert.equal(matches[0].path, 'a.ts');
  assert.equal(matches[0].hitCount, 2);
  assert.deepEqual([...matches[0].laneIds].sort(), ['l1', 'l2']);
  assert.equal(matches[1].path, 'b.ts');
  assert.equal(matches[1].hitCount, 1);
});

test('aggregateMatches without dedupe keeps duplicates and applies cap', () => {
  const laneResults = [
    { id: 'l1', matches: [{ path: 'a.ts', line: 1, text: 'x' }] },
    { id: 'l2', matches: [{ path: 'a.ts', line: 1, text: 'x' }] },
  ];
  const res = aggregateMatches(laneResults, { dedupe: false, cap: 1 });
  assert.equal(res.totalUniqueMatches, 2);
  assert.equal(res.matches.length, 1); // capped
  assert.equal(res.truncated, true);
});

test('overallStatus reflects success / partial / failed / cancelled', () => {
  assert.equal(overallStatus([{ status: 'completed' }, { status: 'completed' }], false), 'success');
  assert.equal(overallStatus([{ status: 'completed' }, { status: 'failed' }], false), 'partial');
  assert.equal(overallStatus([{ status: 'failed' }, { status: 'timeout' }], false), 'failed');
  assert.equal(overallStatus([{ status: 'failed' }], true), 'cancelled');
});

test('runWithConcurrency respects concurrency limit (max in-flight)', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = [1, 2, 3, 4, 5, 6];
  await runWithConcurrency(items, 2, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
  });
  assert.ok(maxInFlight <= 2, `maxInFlight ${maxInFlight} should be <= 2`);
});

test('clamp dampens out-of-range values', () => {
  assert.equal(clamp(99, 1, 8), 8);
  assert.equal(clamp(0, 1, 8), 1);
  assert.equal(clamp(4, 1, 8), 4);
  assert.equal(clamp(NaN, 1, 8), 1);
});

test('provider end-to-end: parallel fan-out over real workspace + lane events + dedupe', async () => {
  const provider = createLocalSearchAggregateProvider({ workspaceRoot: process.cwd() });
  const events = [];
  // 构造一个几乎不可能在仓库里出现的查询词（运行时拼接，避免字面量出现在本测试文件中
  // 被 search_files 自匹配）。
  const missToken = ['qX', 'no', 'match', Date.now().toString(36), 'Zz'].join('_');
  const res = await provider.executeCapability(
    {
      call: {
        toolCallId: 't-e2e',
        capabilityId: 'local.search.aggregate',
        arguments: {
          queries: [
            { id: 'a', label: 'lane A', query: 'createLocalSearchAggregateProvider' },
            { id: 'b', label: 'lane B', query: 'runWithConcurrency' },
            { id: 'c', label: 'miss', query: missToken },
          ],
          max_concurrency: 2,
        },
      },
    },
    {
      locale: 'en-US',
      workspaceRoot: process.cwd(),
      emitLaneProgress: (e) => events.push(e),
    },
  );

  assert.equal(res.grant.granted, true);
  assert.equal(res.result.outputPreview.status, 'success');
  assert.equal(res.result.lanes.length, 3);
  // each lane emitted a running and a terminal event
  const running = events.filter((e) => e.lanePhase === 'running');
  const completed = events.filter((e) => e.lanePhase === 'completed');
  assert.equal(running.length, 3);
  assert.equal(completed.length, 3);
  // miss lane has zero results
  const miss = res.result.lanes.find((l) => l.laneId === 'c');
  assert.equal(miss.laneResultCount, 0);
});

test('provider blocks invalid args with denied grant and no lanes', async () => {
  const provider = createLocalSearchAggregateProvider({ workspaceRoot: process.cwd() });
  const res = await provider.executeCapability(
    { call: { toolCallId: 't-bad', capabilityId: 'local.search.aggregate', arguments: { queries: [] } } },
    {},
  );
  assert.equal(res.grant.granted, false);
  assert.equal(res.result.outputPreview.status, 'blocked');
});

test('provider honors abort signal: aborted before run yields cancelled lanes', async () => {
  const provider = createLocalSearchAggregateProvider({ workspaceRoot: process.cwd() });
  const controller = new AbortController();
  controller.abort();
  const res = await provider.executeCapability(
    {
      call: {
        toolCallId: 't-abort',
        capabilityId: 'local.search.aggregate',
        arguments: { queries: [{ id: 'a', query: 'createLocalSearchAggregateProvider' }] },
      },
    },
    { signal: controller.signal, workspaceRoot: process.cwd() },
  );
  assert.equal(res.result.outputPreview.status, 'cancelled');
  assert.equal(res.result.lanes[0].lanePhase, 'cancelled');
});
