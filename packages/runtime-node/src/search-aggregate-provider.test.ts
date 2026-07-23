import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CapabilityExecutionContext, CapabilityRequest } from '@peer-agent/runtime-core';

import { createNodeSearchAggregateProvider } from './search-aggregate-provider.ts';

function request(input: Record<string, unknown>): CapabilityRequest {
  return {
    capabilityId: 'local.search.aggregate',
    toolCall: {
      toolCallId: 'call-batch-search',
      capabilityId: 'local.search.aggregate',
      input,
    },
    input,
  };
}

function context(signal?: AbortSignal): CapabilityExecutionContext {
  return {
    runId: 'run-batch-search',
    sessionId: 'session-batch-search',
    workspace: { root: '/workspace' },
    signal,
  };
}

test('batch search runs lanes and ranks deduplicated matches by lane hits', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-batch-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  await mkdir(path.join(workspaceRoot, 'src'));
  await writeFile(path.join(workspaceRoot, 'src', 'shared.ts'), 'alpha beta\nalpha only\n', 'utf8');
  await writeFile(path.join(workspaceRoot, 'src', 'other.ts'), 'beta only\n', 'utf8');
  const provider = createNodeSearchAggregateProvider({
    workspaceRoot,
    now: () => '2026-07-23T00:00:00.000Z',
    idFactory: () => 'batch-id',
  });

  const result = await provider.execute(request({
    queries: [
      { id: 'alpha', query: 'alpha', path: 'src' },
      { id: 'beta', query: 'beta', path: 'src' },
    ],
    max_concurrency: 2,
    dedupe: true,
  }), context());

  assert.equal(result.status, 'completed');
  assert.equal(result.permissionGrant?.decision, 'allow');
  const output = result.output as {
    status: string;
    laneCount: number;
    lanes: readonly { id: string; status: string; matchCount: number }[];
    aggregated: {
      totalUniqueMatches: number;
      matches: readonly { path: string; line: number; laneIds: readonly string[]; hitCount: number }[];
    };
  };
  assert.equal(output.status, 'success');
  assert.equal(output.laneCount, 2);
  assert.deepEqual(output.lanes.map(({ id, status, matchCount }) => ({ id, status, matchCount })), [
    { id: 'alpha', status: 'completed', matchCount: 2 },
    { id: 'beta', status: 'completed', matchCount: 2 },
  ]);
  assert.equal(output.aggregated.totalUniqueMatches, 3);
  assert.deepEqual(output.aggregated.matches[0], {
    path: 'src/shared.ts',
    line: 1,
    text: 'alpha beta',
    laneIds: ['alpha', 'beta'],
    hitCount: 2,
  });
});

test('batch search preserves completed lanes when another lane fails', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-batch-partial-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  await writeFile(path.join(workspaceRoot, 'ok.txt'), 'needle\n', 'utf8');
  const provider = createNodeSearchAggregateProvider({ workspaceRoot });

  const result = await provider.execute(request({
    queries: [
      { id: 'ok', query: 'needle' },
      { id: 'missing', query: 'needle', path: 'missing' },
    ],
  }), context());

  assert.equal(result.status, 'completed');
  const output = result.output as {
    status: string;
    completedCount: number;
    failedCount: number;
    aggregated: { totalUniqueMatches: number };
  };
  assert.equal(output.status, 'partial');
  assert.equal(output.completedCount, 1);
  assert.equal(output.failedCount, 1);
  assert.equal(output.aggregated.totalUniqueMatches, 1);
});

test('batch search validates lane count and observes cancellation', async (t) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-runtime-node-batch-invalid-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(workspaceRoot, { recursive: true, force: true })));
  const provider = createNodeSearchAggregateProvider({ workspaceRoot });

  const invalid = await provider.execute(request({ queries: [] }), context());
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.error?.code, 'invalid_queries');

  const controller = new AbortController();
  controller.abort();
  const cancelled = await provider.execute(
    request({ queries: [{ query: 'anything' }] }),
    context(controller.signal),
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error?.code, 'aborted');
});
