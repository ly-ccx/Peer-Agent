import { resolve } from 'node:path';

import type {
  CapabilityManifest,
  CapabilityProvider,
  RuntimeToolResult,
} from '@peer-agent/runtime-core';
import type { RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';

import {
  type NodeFileSearchMatch,
  runNodeFileSearch,
} from './file-search.ts';
import {
  asRecord,
  createNodePermissionGrant,
  createNodeToolResult,
  createProviderRuntimeClock,
  resolveWorkspacePath,
} from './provider-utils.ts';

const CAPABILITY_ID = 'local.search.aggregate';
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_QUERIES = 8;
const AGGREGATE_MATCH_CAP = 500;

const SEARCH_MODE_SCOPES = Object.freeze(['chat', 'plan', 'goal', 'explorer'] as const);

export const NODE_SEARCH_AGGREGATE_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = Object.freeze([
  {
    capabilityId: CAPABILITY_ID,
    displayName: 'Batch search file contents',
    description: 'Run multiple independent content searches in parallel and aggregate their results.',
    riskLevel: 'L1_readonly',
    modeScopes: SEARCH_MODE_SCOPES,
    metadata: { modelToolName: 'batch_search' },
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_QUERIES,
          description: 'Independent content-search lanes to execute.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Optional stable lane identifier.' },
              label: { type: 'string', description: 'Optional human-readable lane label.' },
              query: { type: 'string', description: 'Non-empty substring to search for.' },
              path: { type: 'string', description: 'Optional absolute or workspace-relative path.' },
              case_sensitive: { type: 'boolean', description: 'Use case-sensitive matching.' },
              max_results: { type: 'number', description: 'Maximum results for this lane (1-200).' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
        max_concurrency: {
          type: 'number',
          description: 'Maximum concurrently running lanes (1-8, default 4).',
        },
        dedupe: {
          type: 'boolean',
          description: 'Merge results that have the same path and line. Defaults to true.',
        },
      },
      required: ['queries'],
      additionalProperties: false,
    },
  },
]);

interface SearchLane {
  readonly id: string;
  readonly label: string;
  readonly query: string;
  readonly path?: string;
  readonly caseSensitive: boolean;
  readonly maxResults?: number;
}

interface LaneResult extends SearchLane {
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly matches: readonly NodeFileSearchMatch[];
  readonly errorMessage?: string;
}

interface AggregateMatch extends NodeFileSearchMatch {
  readonly laneIds: readonly string[];
  readonly hitCount: number;
}

function requireNonEmptyString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value.trim();
}

function normalizeLanes(value: unknown): readonly SearchLane[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUERIES) {
    throw new Error('invalid_queries');
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const record = asRecord(candidate);
    const id = typeof record.id === 'string' && record.id.trim()
      ? record.id.trim()
      : `lane-${index + 1}`;
    if (seen.has(id)) throw new Error('duplicate_query_id');
    seen.add(id);
    const query = requireNonEmptyString(record.query, 'invalid_query');
    return {
      id,
      label: typeof record.label === 'string' && record.label.trim()
        ? record.label.trim()
        : query,
      query,
      ...(typeof record.path === 'string' && record.path.trim()
        ? { path: record.path.trim() }
        : {}),
      caseSensitive: record.case_sensitive === true,
      ...(typeof record.max_results === 'number'
        ? { maxResults: record.max_results }
        : {}),
    };
  });
}

function normalizeConcurrency(value: unknown): number {
  const requested = typeof value === 'number' ? Math.floor(value) : DEFAULT_CONCURRENCY;
  return Math.min(MAX_CONCURRENCY, Math.max(1, requested));
}

async function runWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function runWorker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()),
  );
  return results;
}

async function runLane(
  lane: SearchLane,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<LaneResult> {
  if (signal?.aborted) {
    return { ...lane, status: 'cancelled', matchCount: 0, truncated: false, matches: [] };
  }
  try {
    const result = await runNodeFileSearch({
      workspaceRoot,
      targetPath: resolveWorkspacePath(workspaceRoot, lane.path ?? '.'),
      query: lane.query,
      caseSensitive: lane.caseSensitive,
      maxResults: lane.maxResults,
      signal,
    });
    return {
      ...lane,
      status: 'completed',
      matchCount: result.matchCount,
      truncated: result.truncated,
      matches: result.matches,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ...lane,
      status: message === 'aborted' ? 'cancelled' : 'failed',
      matchCount: 0,
      truncated: false,
      matches: [],
      errorMessage: message,
    };
  }
}

function aggregateMatches(
  lanes: readonly LaneResult[],
  dedupe: boolean,
): { readonly matches: readonly AggregateMatch[]; readonly truncated: boolean } {
  const aggregated: AggregateMatch[] = [];
  const byLocation = new Map<string, number>();

  for (const lane of lanes) {
    for (const match of lane.matches) {
      if (aggregated.length >= AGGREGATE_MATCH_CAP) {
        return { matches: aggregated, truncated: true };
      }
      const key = `${match.path}:${match.line}`;
      const existingIndex = dedupe ? byLocation.get(key) : undefined;
      if (existingIndex !== undefined) {
        const existing = aggregated[existingIndex]!;
        aggregated[existingIndex] = {
          ...existing,
          laneIds: existing.laneIds.includes(lane.id)
            ? existing.laneIds
            : [...existing.laneIds, lane.id],
          hitCount: existing.hitCount + 1,
        };
        continue;
      }
      if (dedupe) byLocation.set(key, aggregated.length);
      aggregated.push({ ...match, laneIds: [lane.id], hitCount: 1 });
    }
  }

  aggregated.sort((left, right) =>
    right.hitCount - left.hitCount
      || left.path.localeCompare(right.path)
      || left.line - right.line,
  );
  return { matches: aggregated, truncated: false };
}

function finalStatus(lanes: readonly LaneResult[]): RuntimeToolResult['status'] {
  if (lanes.every((lane) => lane.status === 'cancelled')) return 'cancelled';
  if (lanes.every((lane) => lane.status === 'failed')) return 'failed';
  return 'completed';
}

export function createNodeSearchAggregateProvider(options: {
  readonly workspaceRoot: string;
  readonly now?: () => string;
  readonly idFactory?: () => string;
}): CapabilityProvider {
  if (!options?.workspaceRoot) throw new TypeError('Node search aggregate provider requires workspaceRoot.');
  const workspaceRoot = resolve(options.workspaceRoot);
  const clock = createProviderRuntimeClock(options);

  return {
    providerId: 'runtime-node.search-aggregate',
    capabilities: NODE_SEARCH_AGGREGATE_CAPABILITY_MANIFESTS,
    async execute(request, context) {
      const call = request.toolCall as RuntimeSdkToolCall;
      const input = asRecord(request.input ?? request.toolCall.input);
      if (context.signal?.aborted) {
        return createNodeToolResult({
          clock,
          call,
          status: 'cancelled',
          summary: 'Batch search was cancelled.',
          error: { code: 'aborted', message: 'aborted', recoverable: true },
        });
      }

      try {
        const lanes = normalizeLanes(input.queries);
        const dedupe = input.dedupe !== false;
        const concurrency = normalizeConcurrency(input.max_concurrency);
        const laneResults = await runWithConcurrency(
          lanes,
          concurrency,
          (lane) => runLane(lane, workspaceRoot, context.signal),
        );
        const aggregate = aggregateMatches(laneResults, dedupe);
        const status = finalStatus(laneResults);
        const completedCount = laneResults.filter((lane) => lane.status === 'completed').length;
        const failedCount = laneResults.filter((lane) => lane.status === 'failed').length;
        const cancelledCount = laneResults.filter((lane) => lane.status === 'cancelled').length;
        const grant = createNodePermissionGrant({
          clock,
          call,
          decision: status === 'failed' ? 'deny' : 'allow',
          reason: 'batch_search',
        });
        const laneSummaries = laneResults.map((lane) => ({
          id: lane.id,
          label: lane.label,
          query: lane.query,
          status: lane.status,
          matchCount: lane.matchCount,
          truncated: lane.truncated,
          ...(lane.errorMessage ? { errorMessage: lane.errorMessage } : {}),
        }));
        const summary = `Found ${aggregate.matches.length} unique match(es) across ${lanes.length} lane(s).`;
        return createNodeToolResult({
          clock,
          call,
          status,
          summary,
          output: {
            status: failedCount > 0 || cancelledCount > 0 ? 'partial' : 'success',
            laneCount: lanes.length,
            completedCount,
            failedCount,
            cancelledCount,
            concurrency,
            dedupe,
            lanes: laneSummaries,
            aggregated: {
              totalUniqueMatches: aggregate.matches.length,
              truncated: aggregate.truncated,
              matches: aggregate.matches,
            },
          },
          outputPreview: {
            status: failedCount > 0 || cancelledCount > 0 ? 'partial' : 'success',
            laneCount: lanes.length,
            completedCount,
            failedCount,
            cancelledCount,
            lanes: laneSummaries,
            aggregated: {
              totalUniqueMatches: aggregate.matches.length,
              truncated: aggregate.truncated,
              matches: aggregate.matches.slice(0, 50),
            },
          },
          grant,
          ...(status === 'failed'
            ? { error: { code: 'all_search_lanes_failed', message: 'all_search_lanes_failed', recoverable: true } }
            : {}),
          metadata: { operation: 'batch_search', laneCount: lanes.length },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return createNodeToolResult({
          clock,
          call,
          status: reason === 'aborted' ? 'cancelled' : 'failed',
          summary: `Batch search failed: ${reason}.`,
          grant: createNodePermissionGrant({ clock, call, decision: 'deny', reason }),
          error: { code: reason, message: reason, recoverable: true },
        });
      }
    },
  };
}

export const __testables = {
  aggregateMatches,
  normalizeConcurrency,
  normalizeLanes,
  runWithConcurrency,
};
