import {
  mkdir,
  readFile,
  readdir,
  realpath,
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

export const NODE_FILE_CAPABILITY_MANIFESTS: readonly CapabilityManifest[] = Object.freeze([
  {
    capabilityId: 'local.file.read',
    displayName: 'Read file',
    description: 'Read a UTF-8 text file inside the active workspace.',
    riskLevel: 'L1_readonly',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    capabilityId: 'local.file.list',
    displayName: 'List directory',
    description: 'List direct children of a directory inside the active workspace.',
    riskLevel: 'L1_readonly',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    capabilityId: 'local.file.write',
    displayName: 'Write file',
    description: 'Write a UTF-8 text file inside the active workspace after approval.',
    riskLevel: 'L2_low_write',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        createDirectories: { type: 'boolean' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
]);

function relativeDisplayPath(workspaceRoot: string, targetPath: string): string {
  const path = relative(resolve(workspaceRoot), targetPath);
  return path || '.';
}

async function assertExistingPathInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
): Promise<void> {
  const [rootRealPath, targetRealPath] = await Promise.all([
    realpath(workspaceRoot),
    realpath(targetPath),
  ]);
  resolveWorkspacePath(rootRealPath, targetRealPath);
}

async function assertWritePathInsideWorkspace(
  workspaceRoot: string,
  targetPath: string,
): Promise<void> {
  const rootRealPath = await realpath(workspaceRoot);
  try {
    const targetRealPath = await realpath(targetPath);
    resolveWorkspacePath(rootRealPath, targetRealPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let cursor = dirname(targetPath);
  while (cursor !== dirname(cursor)) {
    try {
      const parentRealPath = await realpath(cursor);
      resolveWorkspacePath(rootRealPath, parentRealPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      cursor = dirname(cursor);
    }
  }
  throw new Error('path_outside_workspace');
}

function requireString(
  input: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = input[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`invalid_${key}`);
  }
  return value;
}

function cancelledResult(
  call: RuntimeSdkToolCall,
  clock: ReturnType<typeof createProviderRuntimeClock>,
): RuntimeToolResult {
  return createNodeToolResult({
    clock,
    call,
    status: 'cancelled',
    summary: 'File capability was cancelled.',
    error: { code: 'aborted', message: 'aborted', recoverable: true },
  });
}

export function createNodeFileProvider(options: NodeFileProviderOptions): CapabilityProvider {
  if (!options?.workspaceRoot) {
    throw new TypeError('Node file provider requires workspaceRoot.');
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  const clock = createProviderRuntimeClock(options);
  const maxReadBytes = Math.max(1, options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);

  return {
    providerId: 'runtime-node.file',
    capabilities: NODE_FILE_CAPABILITY_MANIFESTS,
    async execute(request, context) {
      const call = request.toolCall as RuntimeSdkToolCall;
      if (context.signal?.aborted) return cancelledResult(call, clock);
      const input = asRecord(request.input ?? request.toolCall.input);

      try {
        const targetPath = resolveWorkspacePath(workspaceRoot, input.path);
        const displayPath = relativeDisplayPath(workspaceRoot, targetPath);

        if (request.capabilityId === 'local.file.read') {
          await assertExistingPathInsideWorkspace(workspaceRoot, targetPath);
          const fileStat = await stat(targetPath);
          if (!fileStat.isFile()) throw new Error('not_a_file');
          if (fileStat.size > maxReadBytes) throw new Error('file_too_large');
          const content = await readFile(targetPath, 'utf8');
          if (context.signal?.aborted) return cancelledResult(call, clock);
          const grant = createNodePermissionGrant({
            clock,
            call,
            decision: 'allow',
            reason: 'workspace_read',
          });
          return createNodeToolResult({
            clock,
            call,
            status: 'completed',
            summary: `Read ${displayPath}.`,
            output: { path: displayPath, content, bytes: Buffer.byteLength(content) },
            outputPreview: { path: displayPath, content: content.slice(0, PREVIEW_CHARS) },
            grant,
            metadata: { path: displayPath, operation: 'read' },
          });
        }

        if (request.capabilityId === 'local.file.list') {
          await assertExistingPathInsideWorkspace(workspaceRoot, targetPath);
          const directoryStat = await stat(targetPath);
          if (!directoryStat.isDirectory()) throw new Error('not_a_directory');
          const entries = await readdir(targetPath, { withFileTypes: true });
          if (context.signal?.aborted) return cancelledResult(call, clock);
          const output = entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((entry) => ({
              name: entry.name,
              path: relativeDisplayPath(workspaceRoot, resolve(targetPath, entry.name)),
              type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
            }));
          const grant = createNodePermissionGrant({
            clock,
            call,
            decision: 'allow',
            reason: 'workspace_list',
          });
          return createNodeToolResult({
            clock,
            call,
            status: 'completed',
            summary: `Listed ${displayPath}.`,
            output: { path: displayPath, entries: output },
            outputPreview: { path: displayPath, entries: output.slice(0, 50) },
            grant,
            metadata: { path: displayPath, operation: 'list' },
          });
        }

        if (request.capabilityId === 'local.file.write') {
          const content = requireString(input, 'content', true);
          await assertWritePathInsideWorkspace(workspaceRoot, targetPath);
          const approval = options.requestApproval
            ? await options.requestApproval({
                tool: call.capabilityId,
                toolName: 'Write file',
                capabilityId: call.capabilityId,
                args: input,
                workspacePath: workspaceRoot,
                reason: `Write ${displayPath}`,
                confirmation: {
                  kind: 'capability-approval',
                  approvalKind: 'file-write',
                  reason: 'file_write_requires_approval',
                },
                scope: {
                  kind: 'capability-approval',
                  capabilityId: call.capabilityId,
                  workspaceRoot,
                },
                riskLevel: 'L2_low_write',
                dataLevel: 'D1_internal',
                metadata: { path: displayPath },
              })
            : { granted: false, reason: 'approval_unavailable' };
          if (!approval.granted) {
            const reason = approval.reason || 'user_denied';
            return createNodeToolResult({
              clock,
              call,
              status: 'denied',
              summary: `Write denied for ${displayPath}.`,
              grant: createNodePermissionGrant({ clock, call, decision: 'deny', reason }),
              error: { code: reason, message: reason, recoverable: true },
              metadata: { path: displayPath, operation: 'write' },
            });
          }
          if (context.signal?.aborted) return cancelledResult(call, clock);
          if (input.createDirectories !== false) await mkdir(dirname(targetPath), { recursive: true });
          await writeFile(targetPath, content, 'utf8');
          const grant = createNodePermissionGrant({
            clock,
            call,
            decision: 'allow',
            reason: 'approved_file_write',
          });
          return createNodeToolResult({
            clock,
            call,
            status: 'completed',
            summary: `Wrote ${displayPath}.`,
            output: { path: displayPath, bytes: Buffer.byteLength(content) },
            outputPreview: { path: displayPath, bytes: Buffer.byteLength(content) },
            grant,
            metadata: { path: displayPath, operation: 'write' },
          });
        }

        throw new Error('unsupported_file_capability');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return createNodeToolResult({
          clock,
          call,
          status: reason === 'aborted' ? 'cancelled' : 'failed',
          summary: `File capability failed: ${reason}.`,
          grant: createNodePermissionGrant({ clock, call, decision: 'deny', reason }),
          error: { code: reason, message: reason, recoverable: true },
        });
      }
    },
  };
}
