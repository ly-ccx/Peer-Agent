import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import type {
  CapabilityManifest,
  CapabilityProvider,
  RuntimeToolResult,
} from '@peer-agent/runtime-core';
import type { RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';

import { runNodeFileSearch } from './file-search.ts';
import type { NodeFileProviderOptions } from './provider-contracts.ts';
import {
  asRecord,
  createNodePermissionGrant,
  createNodeToolResult,
  createProviderRuntimeClock,
  resolveWorkspacePath,
} from './provider-utils.ts';

const DEFAULT_MAX_READ_BYTES = 2_000_000;
const PREVIEW_CHARS = 4_000;
const READ_MODE_SCOPES = Object.freeze([
  'chat',
  'plan',
  'goal',
  'explorer',
] as const);
const WRITE_MODE_SCOPES = Object.freeze(['chat', 'goal'] as const);

export const NODE_FILE_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = Object.freeze([
  {
    capabilityId: 'local.file.read',
    displayName: 'Read File',
    description: 'Read a UTF-8 file from an absolute or workspace-relative path.',
    sideEffectLevel: 'L1',
    modeScopes: READ_MODE_SCOPES,
    inputSchema: {
      type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative file path.' } }, required: ['path'], additionalProperties: false,
    },
  },
  {
    capabilityId: 'local.file.list',
    displayName: 'List Files',
    description: 'List direct children of an absolute or workspace-relative directory.',
    sideEffectLevel: 'L1',
    modeScopes: READ_MODE_SCOPES,
    inputSchema: {
      type: 'object', properties: { path: { type: 'string', description: 'Absolute or workspace-relative directory path.' } }, required: ['path'], additionalProperties: false,
    },
  },
  {
    capabilityId: 'local.file.write',
    displayName: 'Write File',
    description: 'Create or replace a UTF-8 file after governed approval and freshness checks.',
    sideEffectLevel: 'L2',
    modeScopes: WRITE_MODE_SCOPES,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        content: { type: 'string', description: 'The complete file content to write.' },
        allow_overwrite: { type: 'boolean', description: 'Set true only when intentionally replacing an existing file after reading it.' },
      },
      required: ['path', 'content'], additionalProperties: false,
    },
  },
  {
    capabilityId: 'local.file.edit',
    displayName: 'Edit File',
    description: 'Replace exact text in a previously read UTF-8 file with conflict protection.',
    sideEffectLevel: 'L2',
    modeScopes: WRITE_MODE_SCOPES,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
        old_string: { type: 'string', description: 'Exact current file content to replace.' },
        new_string: { type: 'string', description: 'Replacement content.' },
        replace_all: { type: 'boolean', description: 'Set true only when every old_string occurrence should be replaced.' },
      },
      required: ['path', 'old_string', 'new_string'], additionalProperties: false,
    },
  },
  {
    capabilityId: 'local.file.search',
    displayName: 'Search Files',
    description: 'Search UTF-8 file contents under an absolute or workspace-relative path.',
    sideEffectLevel: 'L1',
    modeScopes: READ_MODE_SCOPES,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Non-empty substring to search for.' },
        path: { type: 'string', description: 'Optional absolute or workspace-relative file or directory. Defaults to the workspace root.' },
        case_sensitive: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to false.' },
        max_results: { type: 'number', description: 'Maximum matching lines to return (1-200, default 50).' },
      },
      required: ['query'], additionalProperties: false,
    },
  },
]);

function relativeDisplayPath(workspaceRoot: string, targetPath: string): string {
  const path = relative(workspaceRoot, targetPath);
  return path || '.';
}

function requireString(input: Record<string, unknown>, key: string, allowEmpty = false): string {
  const value = input[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`invalid_${key}`);
  return value;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function cancelledResult(call: RuntimeSdkToolCall, clock: ReturnType<typeof createProviderRuntimeClock>): RuntimeToolResult {
  return createNodeToolResult({
    clock, call, status: 'cancelled', summary: 'File capability was cancelled.',
    error: { code: 'aborted', message: 'aborted', recoverable: true },
  });
}

export function createNodeFileProvider(options: NodeFileProviderOptions): CapabilityProvider {
  if (!options?.workspaceRoot) throw new TypeError('Node file provider requires workspaceRoot.');
  const workspaceRoot = resolve(options.workspaceRoot);
  const clock = createProviderRuntimeClock(options);
  const maxReadBytes = Math.max(1, options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
  const readSnapshots = new Map<string, string>();

  return {
    providerId: 'runtime-node.file',
    capabilities: NODE_FILE_CAPABILITY_MANIFESTS,
    async execute(request, context) {
      const call = request.toolCall as RuntimeSdkToolCall;
      if (context.signal?.aborted) return cancelledResult(call, clock);
      const input = asRecord(request.input ?? request.toolCall.input);

      try {
        const rawPath = request.capabilityId === 'local.file.search' && input.path === undefined ? '.' : input.path;
        const targetPath = resolveWorkspacePath(workspaceRoot, rawPath);
        const displayPath = relativeDisplayPath(workspaceRoot, targetPath);

        if (request.capabilityId === 'local.file.read') {
          const fileStat = await stat(targetPath);
          if (!fileStat.isFile()) throw new Error('not_a_file');
          if (fileStat.size > maxReadBytes) throw new Error('file_too_large');
          const content = await readFile(targetPath, 'utf8');
          if (context.signal?.aborted) return cancelledResult(call, clock);
          readSnapshots.set(targetPath, hashContent(content));
          const grant = createNodePermissionGrant({ clock, call, decision: 'allow', reason: 'file_read' });
          return createNodeToolResult({
            clock, call, status: 'completed', summary: `Read ${displayPath}.`,
            output: { path: displayPath, content, bytes: Buffer.byteLength(content), contentHash: readSnapshots.get(targetPath) },
            outputPreview: { path: displayPath, content: content.slice(0, PREVIEW_CHARS) },
            grant, metadata: { path: displayPath, operation: 'read' },
          });
        }

        if (request.capabilityId === 'local.file.list') {
          const directoryStat = await stat(targetPath);
          if (!directoryStat.isDirectory()) throw new Error('not_a_directory');
          const entries = (await readdir(targetPath, { withFileTypes: true }))
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => ({
              name: entry.name,
              path: relativeDisplayPath(workspaceRoot, resolve(targetPath, entry.name)),
              type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
            }));
          const grant = createNodePermissionGrant({ clock, call, decision: 'allow', reason: 'file_list' });
          return createNodeToolResult({
            clock, call, status: 'completed', summary: `Listed ${displayPath}.`,
            output: { path: displayPath, entries }, outputPreview: { path: displayPath, entries: entries.slice(0, 50) },
            grant, metadata: { path: displayPath, operation: 'list' },
          });
        }

        if (request.capabilityId === 'local.file.search') {
          const query = requireString(input, 'query');
          const searchResult = await runNodeFileSearch({
            workspaceRoot,
            targetPath,
            query,
            caseSensitive: input.case_sensitive === true,
            maxResults: input.max_results as number | undefined,
            signal: context.signal,
          });
          const grant = createNodePermissionGrant({ clock, call, decision: 'allow', reason: 'file_search' });
          return createNodeToolResult({
            clock, call, status: 'completed', summary: `Found ${searchResult.matchCount} match(es) under ${displayPath}.`,
            output: {
              query,
              path: displayPath,
              matches: searchResult.matches,
              matchCount: searchResult.matchCount,
              truncated: searchResult.truncated,
            },
            outputPreview: {
              query,
              path: displayPath,
              matches: searchResult.matches.slice(0, 20),
              matchCount: searchResult.matchCount,
            },
            grant, metadata: { path: displayPath, operation: 'search' },
          });
        }

        if (request.capabilityId === 'local.file.write' || request.capabilityId === 'local.file.edit') {
          let previousContent: string | undefined;
          try {
            const targetStat = await stat(targetPath);
            if (!targetStat.isFile()) throw new Error('not_a_file');
            previousContent = await readFile(targetPath, 'utf8');
            const snapshot = readSnapshots.get(targetPath);
            if (!snapshot) throw new Error('read_required');
            if (snapshot !== hashContent(previousContent)) throw new Error('file_changed_since_read');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            if (request.capabilityId === 'local.file.edit') throw new Error('file_not_found');
          }

          let content: string;
          if (request.capabilityId === 'local.file.write') {
            content = requireString(input, 'content', true);
            if (previousContent !== undefined && input.allow_overwrite !== true) throw new Error('allow_overwrite_required');
          } else {
            const oldString = requireString(input, 'old_string');
            const newString = requireString(input, 'new_string', true);
            const occurrences = countOccurrences(previousContent!, oldString);
            if (occurrences === 0) throw new Error('old_string_not_found');
            if (occurrences > 1 && input.replace_all !== true) throw new Error('old_string_not_unique');
            content = input.replace_all === true ? previousContent!.split(oldString).join(newString) : previousContent!.replace(oldString, newString);
          }

          const operationLabel = request.capabilityId.endsWith('.edit') ? 'edit' : 'write';
          const approval = options.requestApproval
            ? await options.requestApproval({
                tool: call.capabilityId,
                toolName: operationLabel === 'edit' ? 'Edit file' : 'Write file',
                capabilityId: call.capabilityId,
                args: input,
                workspacePath: workspaceRoot,
                reason: `${operationLabel}: ${displayPath}`,
                confirmation: {
                  kind: 'capability-approval',
                  approvalKind: 'file-write',
                  reason: 'file_write_requires_approval',
                },
                scope: { kind: 'capability-approval', capabilityId: call.capabilityId, workspaceRoot },
                riskLevel: 'L2_low_write',
                dataLevel: 'D1_internal',
                metadata: { path: displayPath, operation: operationLabel },
              })
            : { granted: true, reason: 'host_policy_allow' };
          if (!approval.granted) {
            const reason = approval.reason || 'denied';
            return createNodeToolResult({
              clock, call, status: 'denied', summary: `File ${operationLabel} denied.`,
              grant: createNodePermissionGrant({ clock, call, decision: 'deny', reason }),
              error: { code: reason, message: reason, recoverable: true },
            });
          }
          if (context.signal?.aborted) return cancelledResult(call, clock);
          await mkdir(dirname(targetPath), { recursive: true });
          await writeFile(targetPath, content, 'utf8');
          readSnapshots.set(targetPath, hashContent(content));
          const operation = request.capabilityId.endsWith('.edit') ? 'edit' : 'write';
          const grant = createNodePermissionGrant({ clock, call, decision: 'allow', reason: approval.reason ?? 'approved' });
          return createNodeToolResult({
            clock, call, status: 'completed', summary: `${operation === 'edit' ? 'Edited' : 'Wrote'} ${displayPath}.`,
            output: { path: displayPath, bytes: Buffer.byteLength(content), contentHash: readSnapshots.get(targetPath) },
            outputPreview: { path: displayPath, content: content.slice(0, PREVIEW_CHARS) },
            grant, metadata: { path: displayPath, operation },
          });
        }

        throw new Error('unsupported_file_capability');
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'file_capability_failed';
        if (reason === 'aborted') return cancelledResult(call, clock);
        return createNodeToolResult({
          clock, call, status: 'failed', summary: `File capability failed: ${reason}.`,
          grant: createNodePermissionGrant({ clock, call, decision: 'deny', reason }),
          error: { code: reason, message: reason, recoverable: true },
        });
      }
    },
  };
}
