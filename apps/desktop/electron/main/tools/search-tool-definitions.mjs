import { readFileSync } from 'node:fs';

import { SHARED_LOCAL_TOOL_CONTRACTS } from '@peer-agent/runtime-core';

export const SEARCH_TOOL_NAMES = {
  batchSearch: SHARED_LOCAL_TOOL_CONTRACTS.batchSearch.toolName,
};

const promptAssetCache = new Map();

function readPromptAsset(filename) {
  if (!promptAssetCache.has(filename)) {
    promptAssetCache.set(
      filename,
      readFileSync(new URL(`./prompts/${filename}`, import.meta.url), 'utf8').trim(),
    );
  }
  return promptAssetCache.get(filename);
}

/**
 * batch_search —— 批量并行检索 + 聚合编排（方案丙）。
 * 模型可见的单一工具，一次调用给出多条子查询；本地 local.search.aggregate
 * Provider 并发 fan-out + 聚合去重重排，返回一份聚合 Evidence。
 * 设计文档：docs/design/batch-search-parallel-aggregation.md
 */
export const SEARCH_TOOL_DEFINITIONS = [
  {
    name: SEARCH_TOOL_NAMES.batchSearch,
    capabilityId: SHARED_LOCAL_TOOL_CONTRACTS.batchSearch.capabilityId,
    prompt: () => readPromptAsset('batch_search.txt'),
    // 只读聚合检索对齐到 chat / plan / goal / explorer。
    availableInModes: ['chat', 'plan', 'goal', 'explorer'],
    runtime: Object.freeze({
      adapter: 'runtime-gateway.local-search-aggregate-provider',
      executorCapabilityId: SHARED_LOCAL_TOOL_CONTRACTS.batchSearch.capabilityId,
    }),
    permissionPolicy: {
      kind: 'file-read',
      requiresReviewForOutsideWorkspace: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          description:
            'List of sub-queries (1-8) to run in parallel. Each runs the same content search as search_files and reports its own lane progress.',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                description: 'Optional stable lane id for UI grouping; generated if omitted.',
              },
              label: {
                type: 'string',
                description: 'Optional human-readable lane label (e.g. "find usages").',
              },
              query: {
                type: 'string',
                description: 'Substring to search for in file contents. Required, non-empty.',
              },
              path: {
                type: 'string',
                description:
                  'Optional workspace-relative directory to scope this sub-query. May point outside the workspace (absolute path) when the access level permits it, e.g. cross-repository investigation. Defaults to the workspace root.',
              },
              case_sensitive: {
                type: 'boolean',
                description: 'Set true for case-sensitive matching. Defaults to false.',
              },
              max_results: {
                type: 'number',
                description: 'Maximum matching lines for this sub-query (1-200, default 50).',
              },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
        max_concurrency: {
          type: 'number',
          description: 'Maximum sub-queries running at once (1-8, default 4).',
        },
        dedupe: {
          type: 'boolean',
          description: 'Merge identical path:line matches across lanes. Defaults to true.',
        },
      },
      required: ['queries'],
      additionalProperties: false,
    },
  },
];
